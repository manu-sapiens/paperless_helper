import { Hono } from 'hono'
import { serve } from 'bun'
import { processDocumentWithPaperless } from './paperless'
import type { PaperlessArchiveResult } from "./paperless";

const HELPER_PORT = import.meta.env.PAPERLESS_HELPER_PORT;//3137;
const app = new Hono()

// GET: Health check endpoint
app.get('/paperless/health', (c) => {

  // TODO: should also check paperless health here
  return c.json({ status: 'ok' });
})

// POST: endpoint for processing URL and filename
app.post('/paperless/process', async (c) => {
  const { url, id, token } = await c.req.json()

  if (!url) return c.json({ error: 'Missing url' }, 400)
  if (!id) return c.json({ error: 'Missing id' }, 400)
  if (!token) return c.json({ error: 'Missing token' }, 400)

  console.log("PROCESSING :", url, id, token);

  // Perform your processing here
  // This is a placeholder for your actual processing logic

  const result: PaperlessArchiveResult = await processDocumentWithPaperless(url, id, token);
  console.log(result);

  return c.json(result);
})

console.log(`Server is running on http://localhost:${HELPER_PORT}`)

serve({
  fetch: app.fetch,
  port: HELPER_PORT
})