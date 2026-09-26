import copy
import heapq
import math
import time
from collections import OrderedDict


class URNQueueImageViewer:
    """
    Live ComfyUI queue media viewer.

    The live queue viewer is implemented in the frontend JavaScript extension.
    This Python class exists so the node can be added to a workflow.
    It has no workflow inputs or outputs and does not need to execute.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "UsefulRandomNodes/Queue"
    DESCRIPTION = (
        "Standalone live viewer for image, video, and audio files referenced by "
        "currently running and pending ComfyUI queue items, with per-job "
        "move, pause/resume, and delete/cancel controls."
    )

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "URNQueueImageViewer": URNQueueImageViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "URNQueueImageViewer": "URN Queue Media Viewer",
}


def _queue_sort_key(item):
    """Match ComfyUI's heap ordering without relying on later tuple fields."""
    try:
        priority = float(item[0])
        if not math.isfinite(priority):
            priority = float("inf")
    except Exception:
        priority = float("inf")

    try:
        prompt_id = str(item[1])
    except Exception:
        prompt_id = ""

    return priority, prompt_id


def _replace_priority(item, priority):
    values = list(item)
    values[0] = priority
    if isinstance(item, tuple):
        return tuple(values)
    return values


def _strict_priorities(ordered_items):
    """
    Reuse the queue's existing priority range, but make equal priorities unique.

    This keeps newly queued normal jobs behaving as before while allowing the
    requested order to be represented unambiguously by ComfyUI's heap queue.
    """
    raw = []
    for index, item in enumerate(ordered_items):
        try:
            value = float(item[0])
            if not math.isfinite(value):
                raise ValueError
        except Exception:
            value = float(index)
        raw.append(value)

    raw.sort()
    strict = []
    for value in raw:
        if strict and value <= strict[-1]:
            value = math.nextafter(strict[-1], math.inf)
        strict.append(value)
    return strict


def _reorder_pending_items(queue_items, prompt_id, action):
    """Return (new_heap_items, ordered_prompt_ids, moved)."""
    ordered = sorted(list(queue_items), key=_queue_sort_key)
    ids = [str(item[1]) for item in ordered]

    if prompt_id not in ids:
        raise KeyError(prompt_id)

    index = ids.index(prompt_id)
    last = len(ordered) - 1

    if action == "up":
        target = max(0, index - 1)
    elif action == "down":
        target = min(last, index + 1)
    elif action == "top":
        target = 0
    elif action == "bottom":
        target = last
    else:
        raise ValueError("action must be one of: up, down, top, bottom")

    moved = target != index
    if moved:
        item = ordered.pop(index)
        ordered.insert(target, item)

    priorities = _strict_priorities(ordered)
    reprioritized = [
        _replace_priority(item, priorities[i]) for i, item in enumerate(ordered)
    ]

    return reprioritized, [str(item[1]) for item in ordered], moved



def _clear_pending_items(prompt_queue):
    """Remove all pending jobs while leaving the currently running job untouched."""
    mutex = getattr(prompt_queue, "mutex", None)
    if mutex is None:
        raise RuntimeError("ComfyUI queue locking is unavailable")

    removed_prompt_ids = []
    with mutex:
        current = list(getattr(prompt_queue, "queue", []))
        removed_prompt_ids = [str(item[1]) for item in current]
        try:
            prompt_queue.queue[:] = []
        except Exception:
            prompt_queue.queue = []
        heapq.heapify(prompt_queue.queue)
        prompt_queue.server.queue_updated()

    return removed_prompt_ids

def _install_pause_aware_get(prompt_queue_class):
    """Patch PromptQueue.get once so a paused queue never dequeues the next job."""
    if getattr(prompt_queue_class, "_urn_qiv_pause_patch_installed", False):
        return

    original_get = prompt_queue_class.get

    def pause_aware_get(self, timeout=None):
        # Standard ComfyUI PromptQueue fields. If a future build changes these,
        # fall back to its native get() rather than breaking queue execution.
        required = ("not_empty", "queue", "task_counter", "currently_running", "server")
        if not all(hasattr(self, name) for name in required):
            return original_get(self, timeout=timeout)

        deadline = None if timeout is None else time.monotonic() + max(float(timeout), 0.0)

        with self.not_empty:
            # Pausing does NOT interrupt currently_running. It only prevents the
            # worker from taking another pending job after the current one ends.
            while len(self.queue) == 0 or bool(getattr(self, "_urn_qiv_paused", False)):
                if deadline is None:
                    self.not_empty.wait()
                    continue

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.not_empty.wait(timeout=remaining)

            item = heapq.heappop(self.queue)
            item_id = self.task_counter
            self.currently_running[item_id] = copy.deepcopy(item)
            self.task_counter += 1
            self.server.queue_updated()
            return item, item_id

    prompt_queue_class._urn_qiv_original_get = original_get
    prompt_queue_class.get = pause_aware_get
    prompt_queue_class._urn_qiv_pause_patch_installed = True


def _set_queue_paused(prompt_queue, paused):
    """Set global pause state and wake the queue worker to re-check it."""
    paused = bool(paused)
    condition = getattr(prompt_queue, "not_empty", None)
    mutex = getattr(prompt_queue, "mutex", None)

    if condition is None or mutex is None:
        raise RuntimeError("ComfyUI queue locking is unavailable")

    # not_empty uses the same queue mutex in ComfyUI. Holding the condition
    # lock makes the state flip + wake-up atomic relative to PromptQueue.get().
    with condition:
        prompt_queue._urn_qiv_paused = paused
        condition.notify_all()

    server = getattr(prompt_queue, "server", None)
    if server is not None and hasattr(server, "queue_updated"):
        server.queue_updated()

    return paused


# Browser-side queue submissions can attach the active ComfyUI workflow tab title
# to the returned prompt ID through these local routes.  Keep the mapping bounded
# so long-running sessions cannot grow it indefinitely.
_WORKFLOW_TAB_TITLES = OrderedDict()
_WORKFLOW_TAB_TITLE_LIMIT = 2048


def _remember_workflow_tab_title(prompt_id, title):
    prompt_id = str(prompt_id or "").strip()
    title = str(title or "").strip()[:240]
    if not prompt_id or not title:
        return False
    _WORKFLOW_TAB_TITLES[prompt_id] = title
    _WORKFLOW_TAB_TITLES.move_to_end(prompt_id)
    while len(_WORKFLOW_TAB_TITLES) > _WORKFLOW_TAB_TITLE_LIMIT:
        _WORKFLOW_TAB_TITLES.popitem(last=False)
    return True


# ComfyUI does not currently expose public queue-reorder or queue-pause endpoints.
# Register tiny local routes. Reordering changes only pending priorities; pausing
# leaves pending jobs in ComfyUI's real queue and simply prevents the worker from
# dequeuing the next one. Existing prompt IDs and payloads stay untouched.
try:
    from aiohttp import web
    from server import PromptServer
    import execution

    _install_pause_aware_get(execution.PromptQueue)

    @PromptServer.instance.routes.get("/urn_queue_image_viewer/workflow_tabs")
    async def urn_queue_image_viewer_workflow_tabs(request):
        return web.json_response({"ok": True, "titles": dict(_WORKFLOW_TAB_TITLES)})

    @PromptServer.instance.routes.post("/urn_queue_image_viewer/workflow_tab")
    async def urn_queue_image_viewer_set_workflow_tab(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)

        prompt_id = str(payload.get("prompt_id", "")).strip()
        title = str(payload.get("title", "")).strip()
        if not prompt_id or not title:
            return web.json_response(
                {"error": "prompt_id and title are required"}, status=400
            )

        _remember_workflow_tab_title(prompt_id, title)
        return web.json_response({"ok": True, "prompt_id": prompt_id, "title": title[:240]})

    @PromptServer.instance.routes.get("/urn_queue_image_viewer/pause")
    async def urn_queue_image_viewer_pause_state(request):
        prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
        if prompt_queue is None:
            return web.json_response(
                {"error": "ComfyUI prompt queue is unavailable"}, status=503
            )
        return web.json_response(
            {"ok": True, "paused": bool(getattr(prompt_queue, "_urn_qiv_paused", False))}
        )

    @PromptServer.instance.routes.post("/urn_queue_image_viewer/pause")
    async def urn_queue_image_viewer_set_pause(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)

        if "paused" not in payload:
            return web.json_response({"error": "paused is required"}, status=400)

        prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
        if prompt_queue is None:
            return web.json_response(
                {"error": "ComfyUI prompt queue is unavailable"}, status=503
            )

        try:
            paused = _set_queue_paused(prompt_queue, bool(payload.get("paused")))
            running, pending = prompt_queue.get_current_queue_volatile()
            return web.json_response(
                {
                    "ok": True,
                    "paused": paused,
                    "running": len(running),
                    "pending": len(pending),
                }
            )
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/urn_queue_image_viewer/reorder")
    async def urn_queue_image_viewer_reorder(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body"}, status=400)

        prompt_id = str(payload.get("prompt_id", "")).strip()
        action = str(payload.get("action", "")).strip().lower()

        if not prompt_id:
            return web.json_response({"error": "prompt_id is required"}, status=400)
        if action not in {"up", "down", "top", "bottom"}:
            return web.json_response(
                {"error": "action must be one of: up, down, top, bottom"},
                status=400,
            )

        prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
        if prompt_queue is None or not hasattr(prompt_queue, "queue"):
            return web.json_response(
                {"error": "ComfyUI prompt queue is unavailable"}, status=503
            )

        mutex = getattr(prompt_queue, "mutex", None)
        if mutex is None:
            return web.json_response(
                {"error": "ComfyUI queue locking is unavailable"}, status=503
            )

        try:
            with mutex:
                current = list(prompt_queue.queue)
                reordered, ordered_ids, moved = _reorder_pending_items(
                    current, prompt_id, action
                )

                # Mutate the existing list where possible so any references held
                # by ComfyUI remain valid, then restore the heap invariant.
                try:
                    prompt_queue.queue[:] = reordered
                except Exception:
                    prompt_queue.queue = list(reordered)
                heapq.heapify(prompt_queue.queue)

                # Same notification used by ComfyUI's own queue mutations.
                prompt_queue.server.queue_updated()

            return web.json_response(
                {"ok": True, "moved": moved, "queue_pending": ordered_ids}
            )
        except KeyError:
            # The item may have started running between the browser click and
            # this request. Running items are intentionally not reorderable.
            return web.json_response(
                {"error": "The job is no longer pending"}, status=409
            )
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/urn_queue_image_viewer/clear_pending")
    async def urn_queue_image_viewer_clear_pending(request):
        prompt_queue = getattr(PromptServer.instance, "prompt_queue", None)
        if prompt_queue is None or not hasattr(prompt_queue, "queue"):
            return web.json_response(
                {"error": "ComfyUI prompt queue is unavailable"}, status=503
            )

        try:
            removed_prompt_ids = _clear_pending_items(prompt_queue)
            for prompt_id in removed_prompt_ids:
                _WORKFLOW_TAB_TITLES.pop(str(prompt_id), None)
            running, pending = prompt_queue.get_current_queue_volatile()
            return web.json_response(
                {
                    "ok": True,
                    "cleared": len(removed_prompt_ids),
                    "removed_prompt_ids": removed_prompt_ids,
                    "running": len(running),
                    "pending": len(pending),
                }
            )
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)


except Exception:
    # Keep the node import-safe in tooling/tests outside a running ComfyUI.
    pass
