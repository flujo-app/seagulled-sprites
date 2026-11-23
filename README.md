# Seagulled: Todd on Sprites

**Talk to Todd. He hires a team of brand-new Fly.io Sprites, checks what they bring back, and fires everyone.**

Todd is a personal agent with a manager's personality: busy, blunt, and he only trusts evidence.
Give him a goal. He asks HR for people, and every person he hires is a fresh Linux computer (a [Sprite](https://fly.io/sprites)) that does the work for real: writes the files, runs them, shows the output.
Todd reads what they did, an AI judge rules on it, the work lands in Box, Todd remembers the whole thing, and every worker Sprite is deleted at the end.

Built for Fly.io's Hacksgiving, 23–29 November 2026.

## How it works

```
 you ──▶ Todd (Sprite "todd-boss", private, sleeps when idle)
          │   brain ........ Gemini (free) / Ollama ┐
          │   verdicts ..... Jev (TypeSafe AI)      │  all through Fly connectors:
          │   memory ....... Pinecone              │  no API key lives on any Sprite
          │   filing ....... Box                   │
          │   chat ......... Slack (optional)      ┘
          │
          └─ connector "todd-hr" ──▶ HR (Sprite "todd-hr")
                                      holds the only hiring key (names todd-w-*,
                                      expires) and keeps the budget
                                      │  one desk on the Free plan: workers take shifts
                                      ├──▶ todd-w-developer-1a2b  (fresh Sprite, deleted after)
                                      └──▶ todd-w-tester-3c4d     (next shift, fresh Sprite)
```

- **Todd** plans the goal, hires 1–3 workers (one after another on the Free plan, which allows 3 Sprites in total: Todd, HR and one worker), flies over once while they work to complain, reviews each result against the evidence, and asks Jev for a typed verdict: ship or not, then promote, keep, redo or fire.
- **HR** is a separate Sprite. It is the only place that can create Sprites, and its key can only make up to 3 Sprites named `todd-w-*`. Todd reaches HR through a Fly Custom API connector, so Todd never sees the hiring key or HR's door code.
- **Workers** each get a brand-new Sprite with nothing on it but a small worker program. They think through the same model connector as Todd (Gemini's free tier, Ollama Cloud, or any OpenAI-style service behind a Custom API connector named `todd-brain`), write files, run commands, and hand back what they made. HR deletes them afterwards, or after 12 minutes at the latest.

## The money

Everything is built to stay inside Fly's Free plan ($5 a month):

- HR keeps a running estimate of what the workers cost and refuses to hire past a hard stop ($2.50 by default).
- HR allows one worker at a time by default (`HR_MAX_WORKERS`), and the hiring key itself allows at most 3 and expires.
- Workers are deleted as soon as their work is judged, and no worker lives longer than 12 minutes.
- Todd and HR sleep when nobody talks to them, and sleeping Sprites are not billed for compute.

## Run it yourself

You need a Fly.io account with Sprites, Node.js 24, and two Sprite tokens from the dashboard (Sprites → Tokens):

1. an **operator token** limited to the name prefix `todd`, for deploying;
2. a **hiring token** limited to the name prefix `todd-w` and 3 Sprites. It only ever goes to HR.

```bash
SPRITES_TOKEN=<operator token> HIRING_TOKEN=<hiring token> node deploy/deploy.mjs
```

The script creates `todd-boss` and `todd-hr`, installs both and prints a new HR door code. Then, in the Fly dashboard under Sprites → Connectors:

- add a **Custom API** connector named `todd-hr`: base URL = HR's Sprite URL, token = the door code, access = name prefix `todd-boss`;
- add **Ollama** (or Google Gemini), **TypeSafeAI**, **Pinecone** and **Box**, with access = name prefix `todd`.

Open Todd's Sprite URL, sign in with your Fly account, and give him a goal.

## Good to know

- Todd is a fictional character. He is rude about work, never about people.
- Without Jev, Todd decides himself; without Pinecone he forgets; without Box the files stay on his Sprite. Only the AI model connector is required.
- Slack: set `TODD_SLACK_CHANNEL` (and `TODD_SLACK_LISTEN=1` to take goals that start with "Todd") on the `todd` service, with the Slack (Bot) connector shared with `todd-boss`.

## License

MIT
