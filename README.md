# Office of the Head of State

A NationStates advisor dashboard. It pulls your nation, your region's RMB and your RP threads, has Gemini turn them into an event chain, and gives you a council of advisors to brief you and take your directives.

Live site: https://pemdem.github.io/ns-advisor/

## First run
1. Open **Settings**. Enter your nation name and your Gemini API key (from aistudio.google.com), then press **Load models** and pick one. A "flash" model is cheap and fast.
2. Add your nation's background (constitution, doctrine, allies, rivals). The advisors always see this.
3. **+ Open a new file** for your nation, your region, and each RP thread.
4. Press **Request new reports** whenever you want an update.

Your key and data stay in that browser only. To move to another device, use **Settings › Export setup** and import the file there, then re-enter your key.

## Reading forum RP threads
Browsers aren't allowed to read forum.nationstates.net pages directly from another site. To fix that, set up a tiny free proxy once:

1. Make a free account at dash.cloudflare.com and go to **Workers & Pages › Create › Worker**.
2. Replace the code with the snippet below, put your nation name in the User-Agent line, and deploy.
3. Copy the worker's address and paste it into **Settings › Forum proxy** like this: `https://your-worker.your-name.workers.dev/?url=`

```js
export default {
  async fetch(req) {
    const u = new URL(req.url).searchParams.get('url');
    if (!u) return new Response('missing url', { status: 400 });
    const target = new URL(u);
    if (!/(^|\.)nationstates\.net$/.test(target.hostname)) return new Response('forbidden', { status: 403 });
    const r = await fetch(target, { headers: { 'User-Agent': 'NS Advisor proxy, run by YOUR NATION NAME' } });
    return new Response(r.body, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/plain', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
```

The proxy only forwards nationstates.net pages, so nobody else can use it for other sites.

Until then, you can paste RP posts or Discord messages into any file with **Add intel by hand**.
