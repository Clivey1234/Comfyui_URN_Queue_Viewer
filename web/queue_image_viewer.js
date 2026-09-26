
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "UsefulRandomNodes.QueueMediaViewer";
const NODE_CLASS = "URNQueueImageViewer";
const TYPE_SUFFIX_RE = /\s*\[(input|output|temp)\]\s*$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)(?:\s*\[(?:input|output|temp)\])?$/i;
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|m2ts)(?:\s*\[(?:input|output|temp)\])?$/i;
const AUDIO_EXT_RE = /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma)(?:\s*\[(?:input|output|temp)\])?$/i;
const DEFAULT_NO_MEDIA_PREVIEW_URL = new URL("./default_media_prompt.png", import.meta.url).href;

const workflowTitleByPromptId = new Map();
const collapsedPromptIds = new Set();
const progressStateByPromptId = new Map();
const fallbackProgressByPromptId = new Map();
let sidebarBadgeCount = 0;
let sidebarBadgeObserver = null;

function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function getPromptEntry(entry) {
    if (Array.isArray(entry)) {
        return {
            number: entry[0],
            promptId: entry[1],
            prompt: entry[2] || {},
        };
    }
    return {
        number: entry?.number ?? entry?.priority ?? "",
        promptId: entry?.prompt_id ?? entry?.promptId ?? "",
        prompt: entry?.prompt ?? {},
    };
}

function comparePendingEntries(a, b) {
    const aa = getPromptEntry(a);
    const bb = getPromptEntry(b);
    const an = Number(aa.number);
    const bn = Number(bb.number);
    const ap = Number.isFinite(an) ? an : Number.POSITIVE_INFINITY;
    const bp = Number.isFinite(bn) ? bn : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return String(aa.promptId || "").localeCompare(String(bb.promptId || ""));
}

function getMediaKindFromString(raw) {
    const value = String(raw ?? "").trim();
    if (IMAGE_EXT_RE.test(value)) return "image";
    if (VIDEO_EXT_RE.test(value)) return "video";
    if (AUDIO_EXT_RE.test(value)) return "audio";
    return null;
}

function looksLikeFilenameOrPath(raw) {
    const value = String(raw ?? "").trim();
    const stripped = value.replace(TYPE_SUFFIX_RE, "").trim();
    return /[\\/]/.test(stripped) || /^[^\r\n]+\.[a-z0-9]{2,5}$/i.test(stripped);
}

function isReferenceOnlyField(key) {
    const k = String(key ?? "").toLowerCase();
    return (
        k.includes("hint") ||
        k.includes("metadata") ||
        k.includes("provenance") ||
        k.endsWith("_json") ||
        k === "json"
    );
}

function isLikelyMediaField(key, nodeType, value) {
    const k = String(key ?? "").toLowerCase();
    const t = String(nodeType ?? "").toLowerCase();

    if (k.includes("prefix") || k.includes("suffix")) return false;
    if (isReferenceOnlyField(k)) return false;
    if (k.includes("text") || k.includes("prompt") || k.includes("caption")) {
        return looksLikeFilenameOrPath(value);
    }

    const keyLooksRight =
        k === "image" ||
        k === "images" ||
        k === "video" ||
        k === "videos" ||
        k === "audio" ||
        k === "file" ||
        k === "files" ||
        k === "filename" ||
        k === "filepath" ||
        k === "file_path" ||
        k === "path" ||
        k === "media" ||
        k.includes("image") ||
        k.includes("video") ||
        k.includes("audio") ||
        k.includes("media") ||
        k.includes("filename") ||
        k.includes("filepath") ||
        k.includes("path") ||
        k.includes("file");

    const typeLooksRight =
        t.includes("load") ||
        t.includes("image") ||
        t.includes("video") ||
        t.includes("audio") ||
        t.includes("media") ||
        t.includes("batch");

    return keyLooksRight || typeLooksRight || looksLikeFilenameOrPath(value);
}

function parseMediaRef(raw, kind) {
    let value = String(raw ?? "").trim();
    let type = "input";

    const suffix = value.match(TYPE_SUFFIX_RE);
    if (suffix) {
        type = suffix[1].toLowerCase();
        value = value.slice(0, suffix.index).trim();
    }

    value = value.replaceAll("\\", "/");

    const isAbsolute =
        /^[a-zA-Z]:\//.test(value) ||
        value.startsWith("/") ||
        value.startsWith("//");

    let subfolder = "";
    let filename = value;

    if (!isAbsolute) {
        const slash = value.lastIndexOf("/");
        if (slash >= 0) {
            subfolder = value.slice(0, slash);
            filename = value.slice(slash + 1);
        }
    }

    return { raw: String(raw), value, type, subfolder, filename, isAbsolute, kind };
}

function makeMediaUrl(ref) {
    if (ref.isAbsolute || !ref.filename) return null;
    const params = new URLSearchParams();
    params.set("filename", ref.filename);
    params.set("type", ref.type || "input");
    if (ref.subfolder) params.set("subfolder", ref.subfolder);
    return `/view?${params.toString()}`;
}

function mediaIdentity(ref) {
    return `${ref.kind}|${ref.type}|${String(ref.value || "").toLowerCase()}`;
}

function collectMedia(prompt) {
    const found = [];
    const byIdentity = new Map();

    for (const [nodeId, def] of Object.entries(prompt || {})) {
        const nodeType = def?.class_type ?? "Unknown";
        const inputs = def?.inputs ?? {};

        const scan = (value, key, depth = 0) => {
            if (depth > 5 || value == null) return;

            if (typeof value === "string") {
                const trimmed = value.trim();
                const kind = getMediaKindFromString(trimmed);
                if (kind && isLikelyMediaField(key, nodeType, trimmed)) {
                    const ref = parseMediaRef(trimmed, kind);
                    const id = mediaIdentity(ref);
                    const existing = byIdentity.get(id);
                    if (existing) {
                        existing.references.push({ nodeId, nodeType, inputName: key });
                        existing.referenceCount = existing.references.length;
                    } else {
                        const item = {
                            nodeId,
                            nodeType,
                            inputName: key,
                            ...ref,
                            references: [{ nodeId, nodeType, inputName: key }],
                            referenceCount: 1,
                        };
                        byIdentity.set(id, item);
                        found.push(item);
                    }
                }
                return;
            }

            if (Array.isArray(value)) {
                for (const item of value) scan(item, key, depth + 1);
                return;
            }

            if (typeof value === "object") {
                for (const [childKey, childValue] of Object.entries(value)) {
                    scan(childValue, childKey || key, depth + 1);
                }
            }
        };

        for (const [key, value] of Object.entries(inputs)) {
            scan(value, key, 0);
        }
    }

    return found;
}

function queueSignature(running, pending) {
    const simplify = (entry) => {
        const e = getPromptEntry(entry);
        const media = collectMedia(e.prompt);
        return [
            e.promptId,
            workflowTitleByPromptId.get(String(e.promptId || "")) || "",
            ...media.map((x) => `${x.kind}:${x.type}:${x.value}:${x.referenceCount}`),
        ].join("|");
    };

    return JSON.stringify({
        running: (running || []).map(simplify),
        pending: (pending || []).map(simplify),
    });
}

function cleanWorkflowTabTitle(value) {
    let title = String(value ?? "").trim();
    if (!title) return "";
    title = title
        .replace(/[•●·*]+\s*$/g, "")
        .replace(/[×✕]+\s*$/g, "")
        .trim();
    return title;
}

function getActiveWorkflowTabTitle() {
    const selectors = [
        '.workflow-tabs [data-state="active"] .workflow-label',
        '.workflow-tabs [aria-selected="true"] .workflow-label',
        '.workflow-tab [data-state="active"] .workflow-label',
        '.workflow-tab [aria-selected="true"] .workflow-label',
        '.workflow-tabs [data-state="active"]',
        '[role="tab"][aria-selected="true"]',
        ".p-togglebutton-checked",
        ".p-selectbutton .p-togglebutton-checked",
        ".workflow-tab.active",
        ".comfyui-workflow-tab.active",
        ".workspace-tab.active",
    ];

    for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
            const candidates = [
                node.getAttribute?.("aria-label"),
                node.getAttribute?.("title"),
                node.querySelector?.(".truncate")?.textContent,
                node.querySelector?.("span")?.textContent,
                node.textContent,
            ];
            for (const candidate of candidates) {
                const title = cleanWorkflowTabTitle(candidate);
                if (title && title !== "+" && title.toLowerCase() !== "workflow") {
                    return title;
                }
            }
        }
    }

    // Conservative geometry fallback for current ComfyUI top-bar tabs.  Only
    // consider short visible buttons near the very top of the application.
    const possible = [...document.querySelectorAll("button")]
        .map((node) => ({ node, rect: node.getBoundingClientRect?.() }))
        .filter(({ rect }) =>
            rect && rect.width > 35 && rect.width < 360 && rect.height >= 22 &&
            rect.height <= 52 && rect.top >= 0 && rect.top < 90 && rect.left < window.innerWidth * 0.75
        )
        .sort((a, b) => a.rect.left - b.rect.left);

    for (const { node } of possible) {
        const title = cleanWorkflowTabTitle(node.textContent);
        if (!title || title === "+") continue;
        if (/^(queue|run|save|load|manager|refresh|settings|menu)$/i.test(title)) continue;
        if (title.length > 80) continue;
        return title;
    }

    return "";
}

async function rememberWorkflowTabTitle(promptId, title) {
    const id = String(promptId || "").trim();
    const cleanTitle = cleanWorkflowTabTitle(title);
    if (!id || !cleanTitle) return;

    workflowTitleByPromptId.set(id, cleanTitle);
    try {
        await fetch("/urn_queue_image_viewer/workflow_tab", {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt_id: id, title: cleanTitle }),
        });
    } catch (_) {}

    window.dispatchEvent(new CustomEvent("urn-qiv-workflow-title", {
        detail: { promptId: id, title: cleanTitle },
    }));
}

function installWorkflowTabCapture() {
    if (api.__urnQueueViewerWorkflowTabCaptureInstalled) return;
    if (typeof api.queuePrompt !== "function") return;

    const originalQueuePrompt = api.queuePrompt.bind(api);
    api.queuePrompt = async function(number, promptData, ...rest) {
        const workflowTabTitle = getActiveWorkflowTabTitle();
        const result = await originalQueuePrompt(number, promptData, ...rest);
        const promptId = result?.prompt_id ?? result?.promptId ?? result?.id;
        if (promptId && workflowTabTitle) {
            rememberWorkflowTabTitle(promptId, workflowTabTitle);
        }
        return result;
    };

    api.__urnQueueViewerWorkflowTabCaptureInstalled = true;
}

async function refreshWorkflowTabTitles() {
    try {
        const response = await fetch("/urn_queue_image_viewer/workflow_tabs", {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
        });
        if (!response.ok) return;
        const data = await response.json();
        const titles = data?.titles;
        if (!titles || typeof titles !== "object") return;
        for (const [promptId, title] of Object.entries(titles)) {
            const cleanTitle = cleanWorkflowTabTitle(title);
            if (promptId && cleanTitle) workflowTitleByPromptId.set(String(promptId), cleanTitle);
        }
    } catch (_) {}
}

function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number)));
}

function getJobProgressPercent(job) {
    const promptId = String(job?.promptId || "");
    if (!promptId) return null;

    const state = progressStateByPromptId.get(promptId);
    const nodes = state?.nodes;
    if (nodes && typeof nodes === "object") {
        const totalNodes = Math.max(1, Object.keys(job?.prompt || {}).length);
        let completedUnits = 0;
        for (const nodeState of Object.values(nodes)) {
            const status = String(nodeState?.state || "").toLowerCase();
            if (status === "finished" || status === "error") {
                completedUnits += 1;
            } else if (status === "running") {
                const max = Number(nodeState?.max);
                const value = Number(nodeState?.value);
                if (Number.isFinite(max) && max > 0 && Number.isFinite(value)) {
                    completedUnits += Math.max(0, Math.min(1, value / max));
                }
            }
        }
        return clampPercent((completedUnits / totalNodes) * 100);
    }

    const fallback = fallbackProgressByPromptId.get(promptId);
    if (fallback) {
        const max = Number(fallback.max);
        const value = Number(fallback.value);
        if (Number.isFinite(max) && max > 0 && Number.isFinite(value)) {
            return clampPercent((value / max) * 100);
        }
    }

    return null;
}

function updateVisibleProgress(promptId) {
    const id = String(promptId || "");
    if (!id) return;
    const state = progressStateByPromptId.get(id);
    const fallback = fallbackProgressByPromptId.get(id);
    const all = document.querySelectorAll(`.urn-qiv-running-progress[data-prompt-id="${CSS.escape(id)}"]`);
    if (!all.length) return;

    // Prefer aggregate progress_state data.  The rendered card stores the total
    // prompt-node count so this can update without re-reading /queue.
    for (const el of all) {
        let pct = null;
        if (state?.nodes && typeof state.nodes === "object") {
            const totalNodes = Math.max(1, Number(el.dataset.totalNodes || 1));
            let completedUnits = 0;
            for (const nodeState of Object.values(state.nodes)) {
                const status = String(nodeState?.state || "").toLowerCase();
                if (status === "finished" || status === "error") completedUnits += 1;
                else if (status === "running") {
                    const max = Number(nodeState?.max);
                    const value = Number(nodeState?.value);
                    if (Number.isFinite(max) && max > 0 && Number.isFinite(value)) {
                        completedUnits += Math.max(0, Math.min(1, value / max));
                    }
                }
            }
            pct = clampPercent((completedUnits / totalNodes) * 100);
        } else if (fallback) {
            const max = Number(fallback.max);
            const value = Number(fallback.value);
            if (Number.isFinite(max) && max > 0 && Number.isFinite(value)) {
                pct = clampPercent((value / max) * 100);
            }
        }
        el.textContent = pct == null ? "" : ` · ${pct}%`;
    }
}

function locateSidebarTabButton() {
    const icon = document.querySelector(".pi.pi-sort-alt");
    if (!icon) return null;
    let node = icon;
    for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
        if (node.matches?.("button,[role='tab'],a")) return node;
        const label = `${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("title") || ""}`.toLowerCase();
        if (label.includes("urn queue")) return node;
    }
    return icon.parentElement;
}

function applySidebarQueueBadge() {
    const target = locateSidebarTabButton();
    if (!target) return false;
    if (getComputedStyle(target).position === "static") target.style.position = "relative";

    let badge = target.querySelector(":scope > .urn-qiv-sidebar-badge");
    if (!badge) {
        badge = document.createElement("span");
        badge.className = "urn-qiv-sidebar-badge";
        badge.style.cssText = [
            "position:absolute",
            "top:2px",
            "right:2px",
            "min-width:15px",
            "height:15px",
            "padding:0 3px",
            "box-sizing:border-box",
            "border-radius:8px",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "font-size:9px",
            "line-height:15px",
            "font-weight:700",
            "background:#d63b3b",
            "color:white",
            "pointer-events:none",
            "z-index:3",
        ].join(";");
        target.appendChild(badge);
    }

    badge.textContent = sidebarBadgeCount > 99 ? "99+" : String(sidebarBadgeCount);
    badge.style.display = sidebarBadgeCount > 0 ? "flex" : "none";
    target.title = sidebarBadgeCount > 0
        ? `URN Queue Media Viewer · ${sidebarBadgeCount} active`
        : "URN Queue Media Viewer";
    return true;
}

function updateSidebarQueueBadge(runningCount, pendingCount) {
    sidebarBadgeCount = Math.max(0, Number(runningCount || 0) + Number(pendingCount || 0));
    if (applySidebarQueueBadge()) return;

    if (!sidebarBadgeObserver) {
        sidebarBadgeObserver = new MutationObserver(() => {
            if (applySidebarQueueBadge()) {
                sidebarBadgeObserver.disconnect();
                sidebarBadgeObserver = null;
            }
        });
        sidebarBadgeObserver.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => {
            if (sidebarBadgeObserver) {
                sidebarBadgeObserver.disconnect();
                sidebarBadgeObserver = null;
            }
        }, 8000);
    }
}

async function refreshSidebarQueueBadge() {
    try {
        const response = await fetch("/queue", {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
        });
        if (!response.ok) return;
        const data = await response.json();
        const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0;
        const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0;
        updateSidebarQueueBadge(running, pending);
    } catch (_) {}
}

function installSidebarQueueBadgeTracker() {
    if (api.__urnQueueViewerBadgeTrackerInstalled) return;
    const events = ["status", "execution_start", "execution_success", "execution_error", "execution_interrupted"];
    const refresh = () => window.setTimeout(refreshSidebarQueueBadge, 30);
    for (const name of events) api.addEventListener(name, refresh);
    api.__urnQueueViewerBadgeTrackerInstalled = true;
    refreshSidebarQueueBadge();
}

function mediaIcon(kind) {
    if (kind === "video") return "🎬";
    if (kind === "audio") return "🎵";
    return "🖼";
}

function mediaKindLabel(kind, count) {
    const base = kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
    return `${count} ${base}${count === 1 ? "" : "s"}`;
}

function summarizeMedia(mediaItems) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const item of mediaItems) counts[item.kind] = (counts[item.kind] || 0) + 1;
    const parts = [];
    if (counts.image) parts.push(mediaKindLabel("image", counts.image));
    if (counts.video) parts.push(mediaKindLabel("video", counts.video));
    if (counts.audio) parts.push(mediaKindLabel("audio", counts.audio));
    return parts.length ? parts.join(" · ") : "No previewable media detected";
}

function getPrimaryMedia(mediaItems) {
    if (!mediaItems?.length) return null;
    return mediaItems.find((x) => x.kind === "video") ||
        mediaItems.find((x) => x.kind === "image") ||
        mediaItems.find((x) => x.kind === "audio") ||
        mediaItems[0];
}

function makeQueueControls(job, queueState, position, pendingCount) {
    const promptId = String(job.promptId || "");
    if (!promptId) return "";

    const controls = [];

    if (queueState === "pending") {
        const moveButton = (action, label, title, disabled) => `
          <button type="button" class="urn-qiv-move"
             data-prompt-id="${esc(promptId)}" data-action="${esc(action)}"
             title="${esc(title)}" aria-label="${esc(title)}" ${disabled ? "disabled" : ""}
             style="width:25px;height:23px;padding:0;border-radius:5px;border:1px solid rgba(255,255,255,.20);cursor:${disabled ? "default" : "pointer"};background:rgba(255,255,255,.07);color:inherit;font-size:13px;line-height:21px;opacity:${disabled ? ".28" : "1"};">${label}</button>`;

        const first = !position || position <= 1;
        const last = !position || position >= pendingCount;
        controls.push(moveButton("top", "⇈", "Move to top of pending queue", first));
        controls.push(moveButton("up", "↑", "Move up one position", first));
        controls.push(moveButton("down", "↓", "Move down one position", last));
        controls.push(moveButton("bottom", "⇊", "Move to bottom of pending queue", last));
    }

    controls.push(`
      <button type="button" class="urn-qiv-delete"
         data-prompt-id="${esc(promptId)}" data-queue-state="${esc(queueState || "pending")}"
         title="Remove this job from the ComfyUI queue"
         style="padding:2px 7px;height:23px;border-radius:5px;border:1px solid rgba(255,100,100,.45);cursor:pointer;background:rgba(160,35,35,.28);color:inherit;font-size:11px;">Delete</button>`);

    return controls.join("");
}

function renderPrimaryPreview(primary) {
    if (!primary) {
        return `
          <img src="${esc(DEFAULT_NO_MEDIA_PREVIEW_URL)}" loading="lazy" draggable="false"
               style="display:block;width:100%;height:180px;object-fit:cover;background:#111;border-radius:6px;"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div style="display:none;height:180px;align-items:center;justify-content:center;text-align:center;background:#111;border-radius:6px;padding:10px;box-sizing:border-box;opacity:.75;">
            No previewable media found
          </div>`;
    }

    const url = makeMediaUrl(primary);
    const unavailable = `
      <div style="height:180px;display:flex;align-items:center;justify-content:center;text-align:center;background:#111;border-radius:6px;padding:10px;box-sizing:border-box;opacity:.75;">
        Preview unavailable<br>${primary.isAbsolute ? "Absolute path" : "File not served by /view"}
      </div>`;

    if (!url) return unavailable;

    if (primary.kind === "video") {
        return `
          <video controls preload="metadata" style="display:block;width:100%;height:180px;object-fit:contain;background:#111;border-radius:6px;">
            <source src="${esc(url)}">
          </video>`;
    }

    if (primary.kind === "audio") {
        return `
          <div style="height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:#111;border-radius:6px;padding:12px;box-sizing:border-box;gap:10px;">
            <div style="font-size:34px;line-height:1;">🎵</div>
            <div style="opacity:.82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${esc(primary.filename || primary.value)}</div>
            <audio controls preload="metadata" src="${esc(url)}" style="width:100%;"></audio>
          </div>`;
    }

    return `
      <img src="${esc(url)}" loading="lazy" draggable="false"
           style="display:block;width:100%;height:180px;object-fit:contain;background:#111;border-radius:6px;"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
      <div style="display:none;height:180px;align-items:center;justify-content:center;text-align:center;background:#111;border-radius:6px;padding:10px;box-sizing:border-box;opacity:.75;">
        Preview unavailable<br>${primary.isAbsolute ? "Absolute path" : "File not served by /view"}
      </div>`;
}

function renderMediaItem(media, workflowTabTitle = "") {
    const url = makeMediaUrl(media);
    const source = media.inputName ? `${media.nodeType} · ${media.inputName}` : media.nodeType;
    const canPreview = !!url;

    let preview = `
      <div style="width:44px;height:44px;flex:0 0 44px;border-radius:5px;background:#111;display:flex;align-items:center;justify-content:center;font-size:20px;">
        ${mediaIcon(media.kind)}
      </div>`;

    let extra = "";

    if (media.kind === "image" && canPreview) {
        preview = `<img src="${esc(url)}" loading="lazy" draggable="false"
            style="width:44px;height:44px;flex:0 0 44px;border-radius:5px;background:#111;object-fit:cover;">`;
    }

    const referenceNote = media.referenceCount > 1
        ? `<div style="font-size:10px;opacity:.56;margin-top:2px;">Referenced by ${esc(media.referenceCount)} nodes in this queued job</div>`
        : "";
    const workflowNote = workflowTabTitle
        ? `<div style="font-size:10px;opacity:.68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;" title="${esc(workflowTabTitle)}">WORKFLOW · ${esc(workflowTabTitle)}</div>`
        : "";

    return `
      <div style="display:flex;gap:8px;align-items:flex-start;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:6px;background:rgba(255,255,255,.03);">
        ${preview}
        <div style="min-width:0;flex:1 1 auto;">
          <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(media.value)}">
            ${esc(mediaIcon(media.kind))} ${esc(media.filename || media.value)}
          </div>
          <div style="font-size:10px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(source)}">
            ${esc(media.kind.toUpperCase())} · ${esc(source)} · node ${esc(media.nodeId)}
          </div>
          ${workflowNote}
          ${extra}
          ${referenceNote}
          ${!canPreview ? `<div style="font-size:10px;opacity:.56;margin-top:3px;">Preview unavailable${media.isAbsolute ? " (absolute path)" : ""}</div>` : ""}
        </div>
      </div>`;
}


function gotoWorkflowTab(workflowTabTitle) {
    const wanted = cleanWorkflowTabTitle(workflowTabTitle);
    if (!wanted) return false;

    const selectors = [
        '.workflow-tabs [role="tab"]',
        '.workflow-tabs button',
        '.workflow-tab',
        '.comfyui-workflow-tab',
        '.workspace-tab',
        '[role="tab"]',
    ];

    const checked = new Set();

    const getTitleCandidates = (node) => [
        node?.querySelector?.(".workflow-label")?.textContent,
        node?.querySelector?.(".truncate")?.textContent,
        node?.getAttribute?.("aria-label"),
        node?.getAttribute?.("title"),
        node?.textContent,
    ];

    for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
            if (checked.has(node)) continue;
            checked.add(node);

            const matches = getTitleCandidates(node)
                .map(cleanWorkflowTabTitle)
                .filter(Boolean)
                .some((title) => title === wanted);

            if (!matches) continue;

            const clickTarget =
                node.closest?.('[role="tab"]') ||
                node.closest?.("button") ||
                node;

            clickTarget.dispatchEvent(
                new MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                })
            );
            return true;
        }
    }

    return false;
}

function makeMediaCard(job, mediaItems, label, position, queueState, pendingCount = 0) {
    const promptId = String(job.promptId || "");
    const shortId = promptId ? promptId.slice(0, 8) : "";
    const primary = getPrimaryMedia(mediaItems);
    const controls = makeQueueControls(job, queueState, position, pendingCount);
    const summary = summarizeMedia(mediaItems);
    const workflowTabTitle = workflowTitleByPromptId.get(promptId) || "";
    const collapsed = collapsedPromptIds.has(promptId);
    const progressPercent = queueState === "running" ? getJobProgressPercent(job) : null;
    const totalNodes = Math.max(1, Object.keys(job?.prompt || {}).length);
    const compactSummary = [summary, workflowTabTitle ? `WORKFLOW · ${workflowTabTitle}` : ""]
        .filter(Boolean)
        .join(" · ");
    const gotoWorkflowButton = workflowTabTitle
        ? `<button type="button" class="urn-qiv-goto-workflow"
                   data-workflow-title="${esc(workflowTabTitle)}"
                   title="Go to workflow tab: ${esc(workflowTabTitle)}"
                   style="height:22px;padding:0 7px;border-radius:4px;border:1px solid rgba(90,110,255,.75);cursor:pointer;background:rgba(45,55,120,.42);color:inherit;font-size:11px;white-space:nowrap;">Goto Workflow</button>`
        : "";
    const itemsHtml = mediaItems.length
        ? mediaItems.map((item) => renderMediaItem(item, workflowTabTitle)).join("")
        : (workflowTabTitle
            ? `<div style="display:flex;gap:8px;align-items:flex-start;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:6px;background:rgba(255,255,255,.03);">
                 <div style="width:44px;height:44px;flex:0 0 44px;border-radius:5px;background:#111;display:flex;align-items:center;justify-content:center;font-size:20px;">🧠</div>
                 <div style="min-width:0;flex:1 1 auto;">
                   <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9;">Text / media prompt workflow</div>
                   <div style="font-size:10px;opacity:.68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;" title="${esc(workflowTabTitle)}">WORKFLOW · ${esc(workflowTabTitle)}</div>
                 </div>
               </div>`
            : ``);

    return `
      <div class="urn-qiv-card" data-job-prompt-id="${esc(promptId)}"
           style="border:1px solid rgba(255,255,255,.14);border-bottom:4px solid rgba(255,0,0,.95);border-radius:8px;padding:8px 8px 10px 8px;margin-bottom:6px;background:rgba(0,0,0,.16);display:flex;flex-direction:column;gap:7px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">
          <div style="display:flex;align-items:center;min-width:0;gap:5px;">
            <button type="button" class="urn-qiv-collapse" data-prompt-id="${esc(promptId)}"
                    title="${collapsed ? "Expand queue item" : "Collapse queue item"}"
                    aria-label="${collapsed ? "Expand queue item" : "Collapse queue item"}"
                    style="width:22px;height:22px;padding:0;border-radius:4px;border:1px solid rgba(255,255,255,.16);cursor:pointer;background:rgba(255,255,255,.05);color:inherit;font-size:12px;line-height:20px;">${collapsed ? "▸" : "▾"}</button>
            <strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(label)}${position ? ` #${position}` : ""}<span class="urn-qiv-running-progress" data-prompt-id="${esc(promptId)}" data-total-nodes="${esc(totalNodes)}">${progressPercent == null ? "" : ` · ${progressPercent}%`}</span></strong>
            ${gotoWorkflowButton}
          </div>
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;flex-wrap:wrap;">
            <span style="opacity:.65;margin-right:2px">${esc(shortId)}</span>
            ${controls}
          </div>
        </div>
        <div style="font-size:10px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(compactSummary)}">${esc(compactSummary)}</div>
        <div class="urn-qiv-card-content" style="display:${collapsed ? "none" : "flex"};flex-direction:column;gap:7px;">
          ${renderPrimaryPreview(primary)}
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${itemsHtml}
          </div>
        </div>
      </div>`;
}

function createQueueViewer(root, options = {}) {
    const isSidebar = !!options.isSidebar;
    root.innerHTML = "";
    root.style.cssText = [
        "width:100%",
        "height:100%",
        "min-height:0",
        "box-sizing:border-box",
        "display:flex",
        "flex-direction:column",
        "gap:7px",
        "font-family:Arial,sans-serif",
        "font-size:12px",
        "overflow:hidden",
        "color:var(--fg-color, #ddd)",
        isSidebar ? "padding:8px" : "",
    ].filter(Boolean).join(";");

    const header = document.createElement("div");
    header.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;";

    const status = document.createElement("div");
    status.textContent = "Reading queue…";
    status.style.cssText = "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    const headerLeft = document.createElement("div");
    headerLeft.style.cssText =
        "display:flex;align-items:center;justify-content:flex-start;gap:8px;min-width:0;flex:1 1 auto;";

    const headerButtons = document.createElement("div");
    headerButtons.style.cssText =
        "display:flex;align-items:center;justify-content:flex-end;gap:5px;flex:0 0 auto;";

    const pauseButton = document.createElement("button");
    pauseButton.textContent = "⏸ Pause Queue";
    pauseButton.type = "button";
    pauseButton.title = "Let the current job finish, then stop before the next queued job starts";
    pauseButton.style.cssText =
        "padding:3px 8px;border-radius:5px;border:1px solid rgba(255,190,80,.42);cursor:pointer;background:rgba(130,90,20,.25);color:inherit;font-weight:600;";

    const clearQueueButton = document.createElement("button");
    clearQueueButton.textContent = "Clear Queue";
    clearQueueButton.type = "button";
    clearQueueButton.title = "Clear all pending queue items and keep the current running job";
    clearQueueButton.style.cssText =
        "padding:3px 8px;border-radius:5px;border:1px solid rgba(255,100,100,.45);cursor:pointer;background:rgba(160,35,35,.28);color:inherit;font-weight:700;";

    const refreshButton = document.createElement("button");
    refreshButton.textContent = "Refresh";
    refreshButton.type = "button";
    refreshButton.style.cssText =
        "padding:3px 8px;border-radius:5px;border:1px solid rgba(255,255,255,.18);cursor:pointer;background:rgba(255,255,255,.07);color:inherit;";

    headerLeft.append(status, clearQueueButton);
    headerButtons.append(pauseButton, refreshButton);
    header.append(headerLeft, headerButtons);

    const body = document.createElement("div");
    body.style.cssText =
        "display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0;flex:1 1 auto;padding-right:2px;";

    root.append(header, body);

    let disposed = false;
    let busy = false;
    let refreshAgain = false;
    let refreshScheduled = false;
    let lastSig = null;
    let queuePaused = false;
    let pauseBusy = false;
    let clearBusy = false;
    let currentPendingCount = 0;
    let requestRefresh = () => {};
    const hiddenPromptIds = new Set();

    const workflowTitleChanged = (event) => {
        const promptId = String(event?.detail?.promptId || "");
        const title = cleanWorkflowTabTitle(event?.detail?.title);
        if (promptId && title) workflowTitleByPromptId.set(promptId, title);
        lastSig = null;
        requestRefresh();
    };
    window.addEventListener("urn-qiv-workflow-title", workflowTitleChanged);

    const updatePauseButton = () => {
        if (pauseBusy) return;
        pauseButton.disabled = false;
        pauseButton.textContent = queuePaused ? "▶ Resume Queue" : "⏸ Pause Queue";
        pauseButton.title = queuePaused
            ? "Resume ComfyUI queue execution"
            : "Let the current job finish, then stop before the next queued job starts";
        pauseButton.style.opacity = "1";
        pauseButton.style.cursor = "pointer";
        pauseButton.style.borderColor = queuePaused
            ? "rgba(100,220,130,.48)"
            : "rgba(255,190,80,.42)";
        pauseButton.style.background = queuePaused
            ? "rgba(35,125,65,.28)"
            : "rgba(130,90,20,.25)";
    };

    const updateClearQueueButton = () => {
        if (clearBusy) return;
        const enabled = currentPendingCount > 0;
        clearQueueButton.disabled = !enabled;
        clearQueueButton.style.opacity = enabled ? "1" : ".4";
        clearQueueButton.style.cursor = enabled ? "pointer" : "default";
        clearQueueButton.title = enabled
            ? "Clear all pending queue items and keep the current running job"
            : "No pending queue items to clear";
    };

    const renderQueue = (data) => {
        const running = Array.isArray(data?.queue_running) ? data.queue_running : [];
        const pendingRaw = Array.isArray(data?.queue_pending) ? data.queue_pending : [];
        const pending = [...pendingRaw].sort(comparePendingEntries);
        currentPendingCount = pending.length;
        updateClearQueueButton();
        updateSidebarQueueBadge(running.length, pending.length);

        const currentIds = new Set(
            [...running, ...pending]
                .map((entry) => String(getPromptEntry(entry).promptId || ""))
                .filter(Boolean)
        );
        for (const promptId of [...hiddenPromptIds]) {
            if (!currentIds.has(promptId)) hiddenPromptIds.delete(promptId);
        }

        status.textContent =
            `${queuePaused ? "PAUSED · " : ""}${running.length ? `${running.length} running · ` : ""}${pending.length} pending`;

        const sig = queueSignature(running, pending);
        if (sig === lastSig) return;
        lastSig = sig;

        const chunks = [];

        running.forEach((rawEntry) => {
            const job = getPromptEntry(rawEntry);
            if (hiddenPromptIds.has(String(job.promptId || ""))) return;
            const media = collectMedia(job.prompt);
            chunks.push(makeMediaCard(job, media, "RUNNING", null, "running", pending.length));
        });

        let visiblePendingPosition = 0;
        pending.forEach((rawEntry) => {
            const job = getPromptEntry(rawEntry);
            if (hiddenPromptIds.has(String(job.promptId || ""))) return;
            visiblePendingPosition += 1;
            const media = collectMedia(job.prompt);
            chunks.push(makeMediaCard(job, media, "QUEUE", visiblePendingPosition, "pending", pending.length));
        });

        if (!chunks.length) {
            body.innerHTML = `
              <div style="padding:18px 10px;text-align:center;opacity:.65;border:1px dashed rgba(255,255,255,.16);border-radius:8px;">
                Queue is empty.
              </div>`;
        } else {
            body.innerHTML = chunks.join("");
        }
    };

    const refresh = async () => {
        if (disposed) return;
        if (busy) {
            refreshAgain = true;
            return;
        }

        busy = true;
        try {
            const pauseRequest = fetch("/urn_queue_image_viewer/pause", {
                method: "GET",
                cache: "no-store",
                credentials: "same-origin",
            }).then(async (response) => {
                if (!response.ok) return null;
                try {
                    return await response.json();
                } catch (_) {
                    return null;
                }
            }).catch(() => null);

            const response = await fetch("/queue", {
                method: "GET",
                cache: "no-store",
                credentials: "same-origin",
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            const pauseState = await pauseRequest;
            if (pauseState && typeof pauseState.paused === "boolean") {
                queuePaused = pauseState.paused;
                updatePauseButton();
            }

            renderQueue(data);
        } catch (err) {
            status.textContent = "Queue read failed";
            body.innerHTML = `
              <div style="padding:10px;border:1px solid rgba(255,100,100,.35);border-radius:8px;">
                Could not read ComfyUI /queue.<br>
                <span style="opacity:.7">${esc(err?.message || err)}</span>
              </div>`;
        } finally {
            busy = false;
            if (refreshAgain && !disposed) {
                refreshAgain = false;
                refresh();
            }
        }
    };

    const setQueuePaused = async (paused) => {
        if (pauseBusy) return;
        pauseBusy = true;
        pauseButton.disabled = true;
        pauseButton.textContent = paused ? "Pausing…" : "Resuming…";
        pauseButton.style.opacity = ".58";
        pauseButton.style.cursor = "default";

        try {
            const response = await fetch("/urn_queue_image_viewer/pause", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paused: !!paused }),
            });

            let result = null;
            try {
                result = await response.json();
            } catch (_) {}

            if (!response.ok) {
                throw new Error(result?.error || `HTTP ${response.status}`);
            }

            queuePaused = !!result?.paused;
            lastSig = null;
        } catch (err) {
            status.textContent = `Queue pause failed: ${err?.message || err}`;
        } finally {
            pauseBusy = false;
            updatePauseButton();
            await refresh();
        }
    };

    const clearPendingQueue = async () => {
        if (clearBusy || currentPendingCount <= 0) return;
        clearBusy = true;
        clearQueueButton.disabled = true;
        clearQueueButton.textContent = "Clearing…";
        clearQueueButton.style.opacity = ".58";
        clearQueueButton.style.cursor = "default";

        try {
            const response = await fetch("/urn_queue_image_viewer/clear_pending", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });

            let result = null;
            try {
                result = await response.json();
            } catch (_) {}

            if (!response.ok) {
                throw new Error(result?.error || `HTTP ${response.status}`);
            }

            const removed = Array.isArray(result?.removed_prompt_ids) ? result.removed_prompt_ids : [];
            for (const promptId of removed) {
                workflowTitleByPromptId.delete(String(promptId));
                hiddenPromptIds.add(String(promptId));
            }
            lastSig = null;
            await refresh();
        } catch (err) {
            status.textContent = `Queue clear failed: ${err?.message || err}`;
        } finally {
            clearBusy = false;
            clearQueueButton.textContent = "Clear Queue";
            updateClearQueueButton();
            await refresh();
        }
    };

    const moveJob = async (promptId, action) => {
        if (!promptId || !action) return;

        for (const button of body.querySelectorAll(".urn-qiv-move")) {
            if (button.dataset.promptId === promptId) {
                button.disabled = true;
                button.style.opacity = ".28";
                button.style.cursor = "default";
            }
        }

        try {
            const response = await fetch("/urn_queue_image_viewer/reorder", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt_id: promptId, action }),
            });

            let result = null;
            try {
                result = await response.json();
            } catch (_) {}

            if (!response.ok) {
                throw new Error(result?.error || `HTTP ${response.status}`);
            }

            lastSig = null;
            await refresh();
        } catch (err) {
            lastSig = null;
            await refresh();
            status.textContent = `Queue move failed: ${err?.message || err}`;
        }
    };

    const cancelJob = async (promptId, queueState) => {
        if (!promptId) return;

        for (const button of body.querySelectorAll(".urn-qiv-delete")) {
            if (button.dataset.promptId === promptId) {
                button.disabled = true;
                button.textContent = queueState === "running" ? "Stopping…" : "Deleting…";
                button.style.opacity = ".55";
                button.style.cursor = "default";
            }
        }

        try {
            let response = await fetch(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
            });

            if (response.status === 404 || response.status === 405) {
                if (queueState === "running") {
                    response = await fetch("/interrupt", {
                        method: "POST",
                        cache: "no-store",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prompt_id: promptId }),
                    });
                } else {
                    response = await fetch("/queue", {
                        method: "POST",
                        cache: "no-store",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ delete: [promptId] }),
                    });
                }
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            hiddenPromptIds.add(promptId);
            for (const card of body.querySelectorAll(".urn-qiv-card")) {
                if (card.dataset.jobPromptId === promptId) card.remove();
            }
            lastSig = null;
            await refresh();
        } catch (err) {
            status.textContent = "Queue delete failed";
            for (const button of body.querySelectorAll(".urn-qiv-delete")) {
                if (button.dataset.promptId === promptId) {
                    button.disabled = false;
                    button.textContent = "Delete";
                    button.style.opacity = "1";
                    button.style.cursor = "pointer";
                }
            }
        }
    };

    const handleProgressState = (event) => {
        const detail = event?.detail || {};
        const promptId = String(detail.prompt_id || "");
        if (!promptId) return;
        progressStateByPromptId.set(promptId, detail);
        updateVisibleProgress(promptId);
    };

    const handleProgress = (event) => {
        const detail = event?.detail || {};
        const promptId = String(detail.prompt_id || "");
        if (!promptId) return;
        fallbackProgressByPromptId.set(promptId, detail);
        updateVisibleProgress(promptId);
    };

    const clearProgressForPrompt = (event) => {
        const promptId = String(event?.detail?.prompt_id || "");
        if (!promptId) return;
        progressStateByPromptId.delete(promptId);
        fallbackProgressByPromptId.delete(promptId);
    };

    api.addEventListener("progress_state", handleProgressState);
    api.addEventListener("progress", handleProgress);
    api.addEventListener("execution_success", clearProgressForPrompt);
    api.addEventListener("execution_error", clearProgressForPrompt);
    api.addEventListener("execution_interrupted", clearProgressForPrompt);

    requestRefresh = () => {
        if (disposed || refreshScheduled) return;
        refreshScheduled = true;
        window.setTimeout(() => {
            refreshScheduled = false;
            refresh();
        }, 25);
    };

    const queueEvents = [
        "status",
        "execution_start",
        "execution_success",
        "execution_error",
        "execution_interrupted",
    ];

    for (const eventName of queueEvents) {
        api.addEventListener(eventName, requestRefresh);
    }

    body.addEventListener("click", (event) => {
        const gotoButton = event.target?.closest?.(".urn-qiv-goto-workflow");
        if (gotoButton && body.contains(gotoButton)) {
            event.preventDefault();
            event.stopPropagation();

            const workflowTitle = String(gotoButton.dataset.workflowTitle || "");
            const switched = gotoWorkflowTab(workflowTitle);
            if (!switched) {
                status.textContent = `Workflow tab not found: ${workflowTitle}`;
            }
            return;
        }

        const collapseButton = event.target?.closest?.(".urn-qiv-collapse");
        if (collapseButton && body.contains(collapseButton)) {
            event.preventDefault();
            event.stopPropagation();
            const promptId = String(collapseButton.dataset.promptId || "");
            if (promptId) {
                if (collapsedPromptIds.has(promptId)) collapsedPromptIds.delete(promptId);
                else collapsedPromptIds.add(promptId);
                lastSig = null;
                refresh();
            }
            return;
        }

        const moveButton = event.target?.closest?.(".urn-qiv-move");
        if (moveButton && body.contains(moveButton) && !moveButton.disabled) {
            event.preventDefault();
            event.stopPropagation();
            moveJob(moveButton.dataset.promptId || "", moveButton.dataset.action || "");
            return;
        }

        const deleteButton = event.target?.closest?.(".urn-qiv-delete");
        if (!deleteButton || !body.contains(deleteButton) || deleteButton.disabled) return;

        event.preventDefault();
        event.stopPropagation();
        cancelJob(deleteButton.dataset.promptId || "", deleteButton.dataset.queueState || "pending");
    });

    pauseButton.addEventListener("click", () => {
        setQueuePaused(!queuePaused);
    });

    clearQueueButton.addEventListener("click", () => {
        clearPendingQueue();
    });

    refreshButton.addEventListener("click", () => {
        lastSig = null;
        requestRefresh();
    });

    refresh();

    return () => {
        if (disposed) return;
        disposed = true;
        window.removeEventListener("urn-qiv-workflow-title", workflowTitleChanged);
        for (const eventName of queueEvents) {
            api.removeEventListener(eventName, requestRefresh);
        }
        api.removeEventListener("progress_state", handleProgressState);
        api.removeEventListener("progress", handleProgress);
        api.removeEventListener("execution_success", clearProgressForPrompt);
        api.removeEventListener("execution_error", clearProgressForPrompt);
        api.removeEventListener("execution_interrupted", clearProgressForPrompt);
    };
}

function registerSidebarQueueViewer() {
    if (app?.extensionManager?.__urnQueueViewerSidebarRegistered) return;
    const registerSidebarTab = app?.extensionManager?.registerSidebarTab;
    if (typeof registerSidebarTab !== "function") return;

    registerSidebarTab({
        id: "urn-queue-media-viewer",
        icon: "pi pi-sort-alt",
        title: "URN Queue",
        tooltip: "URN Queue Media Viewer",
        type: "custom",
        render: (el) => {
            try {
                if (typeof el.__urnQueueViewerCleanup === "function") {
                    el.__urnQueueViewerCleanup();
                }
            } catch (_) {}
            el.innerHTML = "";
            el.style.height = "100%";
            el.style.minHeight = "0";
            const root = document.createElement("div");
            root.style.width = "100%";
            root.style.height = "100%";
            root.style.minHeight = "0";
            el.appendChild(root);
            el.__urnQueueViewerCleanup = createQueueViewer(root, { isSidebar: true });
        },
    });

    app.extensionManager.__urnQueueViewerSidebarRegistered = true;
}

app.registerExtension({
    name: EXTENSION_NAME,

    async setup() {
        installWorkflowTabCapture();
        await refreshWorkflowTabTitles();
        registerSidebarQueueViewer();
        installSidebarQueueBadgeTracker();
    },

    async nodeCreated(node) {
        const matches =
            node?.comfyClass === NODE_CLASS ||
            node?.constructor?.type === NODE_CLASS ||
            node?.type === NODE_CLASS;

        if (!matches) return;

        node.title = "URN Queue Media Viewer";
        node.resizable = true;

        const root = document.createElement("div");
        node.addDOMWidget(
            "queue_image_viewer",
            "queue_image_viewer",
            root,
            {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 220,
                afterResize: () => {
                    root.style.width = "100%";
                    root.style.height = "100%";
                    app.graph?.setDirtyCanvas?.(true, true);
                },
            }
        );

        const currentSize = node.size || [430, 620];
        node.setSize([
            Math.max(430, currentSize[0] || 0),
            Math.max(620, currentSize[1] || 0),
        ]);

        const cleanup = createQueueViewer(root, { isSidebar: false });
        const originalRemoved = node.onRemoved;
        node.onRemoved = function() {
            try {
                cleanup?.();
            } catch (_) {}
            try {
                originalRemoved?.apply(this, arguments);
            } catch (_) {}
        };
    },
});
