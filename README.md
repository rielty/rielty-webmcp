# Move Board

**A UK move-research board that an AI agent and a person edit together, over WebMCP.**

Live: **https://rielty-move-board.netlify.app** · Data: [rielty.co.uk](https://rielty.co.uk) · Licence: MIT

> **No WebMCP-capable browser to hand?** Open the live URL in anything and press
> **▶ Watch it work** — or use
> [**?demo=1**](https://rielty-move-board.netlify.app/?demo=1), which runs it on
> load. Either way it calls the same nine tools, in the order an agent would
> call them, against rielty's live data — nothing is faked. To let a real agent
> drive it, use **Chrome 149+** with `chrome://flags/#enable-webmcp-testing`, or
> **ChatGPT's in-app browser**, which needs no flag.

---

## The problem

Working out where to live in the UK means holding a dozen things in your head
at once: what a street actually sold for, whether an area is rising or
flattening, what your current place is worth, how far it is from work. The data
exists. It is scattered across a dozen tabs, and none of it is comparable
without a spreadsheet.

An AI agent can do that research. But the way agents work today, it hands you
back a wall of prose. You cannot sort it, cannot pin two candidates side by
side, cannot come back to it tomorrow. **The research dies with the
conversation.**

## Why WebMCP is the right fit

Move Board gives the agent nine tools, and they split into two kinds. That
split is the entire idea:

**Four look things up** in rielty's public property corpus — 15.79M UK
sold-price records and 1.96M commute journey times:

| Tool | What it does |
| --- | --- |
| `search_properties` | Natural-language search over UK property records |
| `property_details` | One property: facts, price position, commutes, schools, full sale history, comparables |
| `area_report` | What an area is like and how its prices are moving |
| `estimate_value` | What a home of a given size is worth in a town, from sold history |

**Five edit the board** — and have no server behind them at all:

| Tool | What it does |
| --- | --- |
| `add_to_board` | Pin a finding so it outlives the conversation |
| `remove_from_board` | Unpin one |
| `get_board` | Read back what is pinned — **including what the person changed by hand** |
| `compare_on_board` | Put two or three cards side by side as a table |
| `annotate_card` | Write onto a card why it is a contender |

A plain MCP server could do the first four. **Only WebMCP can do the second
five**, because they act on a surface the person is looking at, in their
browser, in their session. There is nothing to authenticate and no state to
sync — the board is simply *there*, for both of you.

## Where is the chat box?

There isn't one, and that is the point. **The agent is not in the page — it is
whatever is browsing it.** Open this page inside ChatGPT's in-app browser and
type into ChatGPT as you normally would; it discovers the nine tools this page
publishes and calls them while you watch. The page is a surface an agent acts
on, not an app with an assistant bolted into the corner.

That is also why `?demo=1` and the **Watch it work** button exist: without an
agent present there is nothing to see, which looks broken rather than empty.

## What this makes possible that wasn't before

Inside ChatGPT's in-app browser, ask:

> "I'm moving to Yorkshire on a £400k budget, 3 beds minimum. Research it and
> keep the three best on the board, with a note on each explaining the catch."

Then watch. Findings appear as it searches. Cards land on the board as it
decides what matters. Notes get written onto them. When it finishes you have
**an artifact, not a transcript** — and you can then drag it around yourself,
drop the one you never liked, and the agent sees your edit next time it calls
`get_board`.

That is the shift: the agent is not answering a question and leaving. It is
**editing a document you both own**, and you get to keep it.

## How WebMCP is implemented

All of it is in [`app.js`](app.js). Tools are declared as data and registered
in one loop:

```js
document.modelContext.registerTool({
  name: "add_to_board",
  description: "Pin a finding to the board so it survives the conversation…",
  inputSchema: {
    type: "object",
    properties: {
      card_id: { type: "string", description: "card_id from a lookup tool." },
      note: { type: "string", description: "Why this one is worth keeping. Optional." }
    },
    required: ["card_id"]
  },
  execute: async (input) => { /* mutate the board, re-render, reply */ }
});
```

Three details worth calling out:

1. **Every tool renders.** `execute()` mutates board state and re-renders
   before it resolves, so the human sees the result at the same moment the
   agent receives it. No polling, no websocket.
2. **`readOnlyHint` is declared per tool**, never inferred from its name —
   `search_properties` is *not* read-only, because it changes what is on
   screen even though it writes no data.
3. **Progressive enhancement.** If `modelContext` is absent the page says so,
   tells you how to get it, and stays fully usable by hand. Nothing throws.
4. **The page demonstrates itself.** A page whose whole job is to expose tools
   shows a visitor nothing until an agent arrives — which in Safari, Firefox,
   or Chrome without the flag is indistinguishable from being broken. The
   **Watch it work** button calls the same tool functions in the same order,
   so the page proves itself in any browser.

### Why there is a serverless function

`netlify/functions/mcp.mjs` is a thin bridge to rielty's public MCP endpoint.
It exists for exactly one reason: **the browser cannot call that endpoint
directly.** `https://rielty.co.uk/mcp/v1` sends no CORS headers, answers
`OPTIONS` with a 405, and does not expose the `mcp-session-id` header that its
handshake depends on. So the page calls `/api/mcp`, and the function speaks MCP
— `initialize`, `notifications/initialized`, then `tools/call`.

The endpoint is anonymous and read-only, so there is no secret here. The
function also refuses any tool name outside the four rielty publishes, so it
cannot be used as an open relay.

## Running it locally

```bash
npm install -g netlify-cli   # only dependency, and only for local dev
netlify dev                  # serves the page and the function together
```

Then open the printed URL in a WebMCP-capable browser:

- **Chrome 149+** with `chrome://flags/#enable-webmcp-testing` enabled, or
- **ChatGPT's in-app browser**, which supports WebMCP with no flag.

Check the tools registered:

```js
await document.modelContext.getTools()   // → nine tools
```

Note that `executeTool` takes the tool *object* and a **JSON string**, not a
name and an object:

```js
const tools = await document.modelContext.getTools();
const search = tools.find(t => t.name === "search_properties");
await document.modelContext.executeTool(search, JSON.stringify({ requirements: "3 bed in Leeds under £400k" }));
```

There is no build step. `index.html`, `styles.css`, `app.js` and one function
are the whole application.

## Honest limits

- **The corpus is predominantly sold-price history, not homes for sale.** Every
  result carries a `listing_type`, and the tool descriptions tell the agent to
  check it before calling something available.
- **Valuations are statistical**, derived from local sold prices — not a
  valuation of any specific address. Where there are too few local sales the
  tool returns no figure and says why, rather than guessing.
- **The board lives in `localStorage`.** It survives a reload on this browser;
  it does not sync across devices.
- Each proxy call performs its own MCP handshake when the serverless instance
  is cold. Warm instances reuse the session.

## Related

rielty publishes these same four tools as a conventional MCP server at
`https://rielty.co.uk/mcp/v1` ([docs](https://rielty.co.uk/mcp)), and runs
WebMCP in its own product surface too. This repository is the standalone,
open-source demonstration of what the browser half makes possible.
