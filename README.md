# URN Queue Media Viewer

**URN Queue Media Viewer** is a standalone ComfyUI queue visualisation and queue-management extension designed to make long, mixed-media queues easier to understand and control.

Instead of showing only a list of prompt IDs, it turns each queued workflow into a visual card containing its media inputs, workflow name, queue position and controls. It lives primarily in its own **URN Queue** sidebar tab, so it remains available regardless of which workflow is currently open.

The extension does not depend on VHS or another third-party queue/media package.

---

## What it does

URN Queue Media Viewer adds a richer view of ComfyUI's running and pending jobs.

Each queued workflow can show:

- the workflow tab that created it
- image, video and audio inputs
- a large primary preview
- compact media asset entries
- running progress information
- its current queue position
- controls for moving or removing the job
- a direct **Goto Workflow** button

Text-only or non-media workflows are also represented, using a bundled placeholder image rather than an empty preview.

---

## Queue visualisation

A single ComfyUI prompt is treated as a single queue item.

If a workflow contains several media inputs, they are grouped together rather than appearing as separate jobs.

For example, one queued workflow may contain:

- 2 images
- 1 video
- 1 audio file

All four assets remain attached to the same queue card.

The main preview is used for image display or audio/video playback. Audio and video files in the lower asset list are deliberately kept compact so the interface does not duplicate media players.

---

## Supported media

The viewer recognises direct queued references to common media formats.

| Media | Formats |
| --- | --- |
| Images | PNG, JPG, JPEG, WEBP, BMP, GIF, TIFF |
| Video | MP4, M4V, MOV, MKV, WEBM, AVI, WMV, MPG, MPEG, M2TS |
| Audio | MP3, FLAC, WAV, M4A, AAC, OGG, OPUS, WMA |

Media is detected from the queued prompt itself rather than from specific third-party loader node names.

This allows the viewer to remain independent of VHS and other custom media packs.

---

## Media deduplication

Some workflows pass the original media filename through several downstream nodes as metadata, provenance or filename hints.

URN Queue Media Viewer detects this and prevents the same physical file from appearing several times in one queue card.

Repeated references are deduplicated using the media type, ComfyUI storage location and normalised file path.

Metadata-style fields such as filename hints are ignored as additional media sources.

---

## Workflow tracking

When a prompt is submitted, the extension records the active ComfyUI workflow tab against the returned prompt ID.

That allows queue cards to show information such as:

```text
WORKFLOW · MiniMaxH3_Ref to Video
```

A **Goto Workflow** button appears when the originating workflow tab is known.

If that tab is still open, clicking the button switches directly back to it.

This makes the queue useful as a navigation tool as well as a queue monitor.

---

## Queue management

The extension controls the actual ComfyUI queue rather than maintaining a separate visual-only list.

### Reordering

Pending workflows can be moved using:

```text
⇈  Move to top
↑  Move up
↓  Move down
⇊  Move to bottom
```

The real pending execution order is changed while preserving the original prompt IDs and queued workflow data.

Running jobs are never reordered.

### Delete / Cancel

Each queue card has a **Delete** button.

For a pending job it removes that prompt from the queue.

For a running job it cancels / interrupts the active prompt.

### Pause / Resume

The global queue can be paused without interrupting the workflow that is already running.

When paused:

- the current job finishes normally
- pending jobs remain queued
- new jobs can still be added
- pending jobs can still be reordered or deleted
- ComfyUI does not take the next job until the queue is resumed

### Clear Queue

The red **Clear Queue** control removes every pending job while deliberately leaving the currently running workflow untouched.

---

## Running progress

When ComfyUI provides progress events, the currently running queue card displays live progress information.

This makes it easier to distinguish between a job that has only just started and one that is close to completion without leaving the queue sidebar.

---

## Long-queue readability

Large queues can quickly become visually dense, so the viewer includes several features specifically aimed at readability:

- collapse / expand controls for every queue card
- a sidebar badge showing the number of active jobs
- thick red separators between queued workflows
- compact lower asset rows
- workflow names displayed alongside queued media
- large primary media previews
- a dedicated fallback preview for workflows with no previewable media

---

## Sidebar integration

The primary interface is registered through ComfyUI's sidebar extension API.

The tab is named:

```text
URN Queue
```

and uses the official PrimeIcons icon:

```text
pi pi-sort-alt
```

The viewer is therefore always available from the ComfyUI sidebar and does not need to be added to every workflow.

---

## Legacy node compatibility

The package still includes the original graph node:

```text
URN Queue Media Viewer
```

Category:

```text
UsefulRandomNodes / Queue
```

The node has no workflow inputs or outputs and does not need to execute.

It remains in the package so workflows created with older versions do not break.

---

## Independence

URN Queue Media Viewer is designed to be self-contained.

It does **not** require:

- VHS
- a third-party queue manager
- a third-party video preview extension
- a third-party audio preview extension

Its queue controls, workflow tracking and media detection are implemented inside the extension itself.

The browser uses ComfyUI's own media-serving capability for previewable files.

---

## Installation

### Manual installation

Copy or extract the folder:

```text
URN_Queue_Image_Viewer
```

into:

```text
ComfyUI/custom_nodes/
```

Then restart ComfyUI and refresh the browser.

---

### Install with pip / Comfy CLI

If you use the Comfy Registry workflow, first install or update **Comfy CLI** with pip:

```bash
python -m pip install --upgrade comfy-cli
```

On the Windows portable build, use ComfyUI's embedded Python:

```bat
python_embeded\python.exe -m pip install --upgrade comfy-cli
```

Then install the published node from the Comfy Registry:

```bash
comfy node install <registry-node-id>
```

Replace `<registry-node-id>` with the package ID shown on the node's Comfy Registry page.

After installation, restart ComfyUI.

> The node itself has no additional third-party Python package requirements beyond ComfyUI.

---

## Package structure

```text
URN_Queue_Image_Viewer/
├── __init__.py
├── queue_image_viewer.py
├── README.txt
└── web/
    ├── queue_image_viewer.js
    └── default_media_prompt.png
```

The Python backend handles queue state, queue reordering, pause/resume, clearing pending jobs and workflow-title persistence.

The JavaScript frontend handles the sidebar interface, media detection, previews, progress display, queue-card rendering and workflow-tab navigation.

---

## Current baseline

Current accepted build:

```text
URN_Queue_Image_Viewer_V6_9_Goto_Workflow.zip
```

This baseline includes:

- ComfyUI sidebar integration
- image, video and audio queue previews
- mixed-media workflow cards
- media deduplication
- workflow-name tracking
- Goto Workflow
- real queue reordering
- Delete / Cancel
- Pause / Resume
- Clear Queue
- running progress display
- collapse / expand
- active-job sidebar badge
- text/non-media fallback preview
- compact audio/video asset rows
- red queue separators
- legacy node compatibility

---

## Purpose

The project is intended to answer one simple question:

> **What is actually waiting in my ComfyUI queue, and what workflow does each item belong to?**

It turns ComfyUI's queue into a visual, workflow-aware media queue while keeping direct control over the real pending jobs.
