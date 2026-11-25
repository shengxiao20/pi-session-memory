# pi-session-memory

**Current version: 2.0.11**

Search your Pi conversation history, compare historical perspectives, and save cited knowledge for later work.

[Project website](https://shengxiao20.github.io/pi-session-memory/) · [npm](https://www.npmjs.com/package/pi-session-memory) · [CHANGELOG.md](CHANGELOG.md)

## Core features

- **Find past decisions.** Search original user and assistant text across Pi sessions using case-insensitive literal keyword and phrase matching.
- **Compare historical perspectives.** Consult selected historical Pi agents through optional multi-agent Discussion, then ask private follow-up questions.
- **Keep reusable knowledge.** Save cited findings or current context as draft Open Knowledge Format (OKF) Markdown documents. Reuse saved knowledge in later reviews.

The plugin complements Pi's context compaction by preserving access to source transcripts.

## Get started

1. Install the package:

   ```bash
   pi install npm:pi-session-memory
   ```

2. Start or restart Pi. Open `/pi-session-memory` and select **Agentic setup**.
   The agent explains each option and asks one question at a time.
   Review the proposed settings and approve the final save.

3. After setup, approve the separate history import when prompted.
   You can also select **Import history** from `/pi-session-memory` later.
   Full import can restore sessions that you manually deleted from the SQLite index.

To update the package, run `pi update`.

## Use your history

Ask Pi explicitly to look back at earlier work:

> Look back at our OAuth renewal conversations. What did we decide, and which questions remain?

Pi checks saved knowledge first. It searches source transcripts when no saved description matches your request.
New reviews save conclusions with source citations and return the saved OKF document.

To compare historical agents' perspectives, select **Discussion** when prompted:

> Review our earlier OAuth renewal conversations with historical agents and compare their answers.

Pi opens a checklist of eligible sessions. Confirm the sessions that you want to consult.

You can also save the current context directly:

> Save the current context as OKF.

Saved knowledge uses your configured `knowledgePath`, or `~/.pi/agent/pi-session-memory/knowledge` by default.

## Choose how Pi reviews evidence

Set `recallMode` during setup or through **Edit configuration**:

| Mode | Behavior |
| --- | --- |
| `choice` (default) | Ask you to choose Normal or Discussion after each search. |
| `normal` | Compare retrieved transcript evidence and save findings. |
| `discussion` | Consult confirmed historical sessions and save findings. |

**Edit configuration** saves each valid field immediately.
The command menu also provides database session management, usage statistics, and indexed-tool-turn cleanup.
See the [setup reference](prompts/setup.md) for configuration details.

## Data and model use

SQLite search and storage run locally. History import starts through your explicit approval or menu selection.
Optional relevance filtering uses your configured model service. Discussion uses your Pi model and in-memory session copies.
Consultation leaves the original historical transcript files unchanged.
Review cited evidence before treating findings as verified.

## Source architecture

See the [architecture overview and source map on GitHub Pages](https://shengxiao20.github.io/pi-session-memory/#architecture).
