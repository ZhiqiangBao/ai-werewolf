# Quick start

[简体中文（README）](../README.md) · English · [日本語](Quick-start.ja.md)

Use this guide to start the game on your own computer, prepare a room, and invite people to seats. This repository provides the application source; these steps do not connect you to a hosted game service.

## 1. Install and start

Install **Node.js 22.12 or newer** and **pnpm**. If pnpm is not available, install it with:

```bash
npm install -g pnpm
```

Clone the repository and start development mode:

```bash
git clone https://github.com/ZhiqiangBao/ai-werewolf.git
cd ai-werewolf
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173/** in your browser. The development page and its API use the same local service.

To start in production mode, first run `pnpm build`, then run `pnpm start`. Rebuild after changing web source files, and restart after changing server source files.

## 2. Choose your interface language

Use the language selector on the home page or in a room. The interface language is saved in the current browser. It belongs to you and does not change a room’s game language.

## 3. Create a room and choose its game language

On the home page, select **Create a match**. In the room setup:

1. Choose a preset and review its rules.
2. Select the **Match language**. New rooms default to Simplified Chinese (`zh-CN`); English (`en`) and Japanese (`ja`) are also available. The room uses this language for its rules, moderator messages, and the language requested of models. The choice is fixed when the game starts.
3. Decide which seats are simulated players, model-controlled seats, or human seats.

Simulated players run without an external model service or API key. To use a real model, add it to the project model library with its protocol, endpoint, model name, and API key; then choose it for a seat and use **Test** to check the connection. If the check fails, verify that the endpoint matches the selected protocol and that the model name and key are correct.

## 4. Invite human players and start

Open **Invite links** in the setup page. Keep the host link for yourself. Send each human the link for their assigned seat; send the spectator link only to people who should watch. Each link grants its corresponding view, so give it only to its intended recipient.

Each human opens their own seat link, enters a name, and marks themselves ready. When all human seats are ready and the setup validation shows no remaining issue, the host can start the game. Roles are dealt by the rules engine.

## 5. Play and review

The seat page shows the current task and its permitted actions. Choose an available action and target, enter speech in your own words, and submit it. A speech, plan, or claim written by a player stays in the language and wording they submitted; the game does not translate it. The interface language affects controls and labels, while the room language governs game rules and system text. Models are asked to use the room language, but they may not always follow that request.

The host view includes the full game state. A seat view contains information authorized for that seat, and spectators see public information. Use the event log to review the messages and results visible to your view.

If a link opens the wrong view, ask the host for the correct host, seat, or spectator link. If a human cannot act, check that the game has started and that the correct seat link is open. If the room cannot start, resolve the setup validation items shown on the page.

## Language and saved history

Changing the interface language does not change a room or rewrite its history. A room keeps its game language after it starts. Older rooms without a saved language use `zh-CN`. Player speech is preserved as submitted, and history that cannot be reliably reconstructed is not rewritten to imitate a new language. Video export keeps its existing locale interfaces; this does not promise fully localized subtitles, audio, or historical text.
