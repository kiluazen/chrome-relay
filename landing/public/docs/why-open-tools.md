# The model should be the replaceable part

> Don't let the model vendor own the accumulated work around the model.


The model is not the thing you should be loyal to.

The model will change. Today it's Claude, tomorrow Codex, next year something else. That part is obvious.

The thing that actually compounds is everything around the model: your scripts, your memory, your browser workflows, your weird local setup, the way your agent uses your machine.

If that lives inside one vendor's runtime, you're not choosing the best model anymore. You're choosing the model that owns your setup.

That's the trap with browser extensions from model companies.

Claude in Chrome and Codex Chrome are good. They [both drive your real logged-in Chrome](/docs/vs-claude-codex/). That's not the issue.

The issue is that workflows built there become Claude-shaped or Codex-shaped. When the better model changes, you either rebuild the workflow or stay stuck.

chrome-relay is built against the opposite bet.

Browser control should sit below the model layer. Same place as your shell, files, editor, git repo. Boring tools. Tools no model vendor owns.

Then the model becomes a config value.

Claude Code can run:

```sh
chrome-relay snapshot -i
chrome-relay click @e12
```

Codex can run the same thing. A cron script can run the same thing. Some agent in 2027 can run the same thing.

That's why chrome-relay is open source, local, and a CLI.

Not because vendor extensions can't control Chrome. They can.

Because your browser workflows should survive the model changing.

The browser is yours. The agent is replaceable.
