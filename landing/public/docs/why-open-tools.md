# Swap the model, keep everything

> Why the tools around AI need to be open — and why chrome-relay is a CLI instead of someone's plugin.


Models leapfrog each other every few months. Whatever you're using today won't be the best one a year from now. That fact should shape every tool decision you make around AI — and it's the reason chrome-relay exists in the shape it does.

## 1. The lock-in that matters isn't the model

The model is the most replaceable part of your setup. What accumulates is everything around it: your memory, your workflows, your scripts, your browser access, the muscle memory of how you work. If all of that lives inside one vendor's harness, then today's best model quietly decides your stack forever.

## 2. The trap: best model AND your context

The worst outcome isn't one company having the best model — you just use it. The worst outcome is one company having the best model *and* your memory, workflows, and tooling locked inside their harness. The day someone else ships a better model, you're choosing between the better model and everything you've accumulated. Most people will choose the accumulation. That's not a choice, that's a moat — and you're the one inside it.

The time to design this out is now, while switching is still cheap.

## 3. Vendor browser extensions are this trap in miniature

Claude in Chrome and the Codex Chrome extension are both good — [both drive your real logged-in Chrome](/docs/vs-claude-codex/), same as chrome-relay. But each works only inside its vendor's runtime. Build your browser workflows on one and they become Claude-shaped or Codex-shaped: switch models and you rebuild everything, or you don't switch.

## 4. The test: change one line, everything else keeps working

Workflows should be written against surfaces no vendor owns — the shell, files, open protocols. Then the model is a config value. A CLI passes this test for free: anything that can run shell commands can run `chrome-relay snapshot -i` and `click @e12` — Claude Code today, Codex tomorrow, a cron script with no model at all, whatever's best in 2027. Same commands, same [skill](/docs/skill/), same scripts. The system stays infinitely switchable.

## 5. So: open source, local, a CLI

chrome-relay is MIT-licensed, runs entirely on your machine, and speaks the most boring interface that exists. Not because vendor extensions can't control your browser — they can — but because the browser-control layer belongs *below* the model layer, with your editor and your shell, where no model vendor can hold it. The browser is yours. The agent driving it is your choice. Those two facts should stay independent — and they should *keep* being independent every time you change your mind about the agent.
