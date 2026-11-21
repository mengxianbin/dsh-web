/**
 * OpenAPI 3.1.0 description of the dsh-market.com edge API. Served at
 * GET /openapi.json and linked from the API catalog as service-desc.
 *
 * The path objects are assembled from API_ROUTES (api-surface.js), the single
 * description authority for this API; a new route is described there, not here.
 */
import { API_ROUTES } from './api-surface.js'

/** Path objects keyed by path, each holding its methods. */
const paths = {}
for (const route of API_ROUTES) {
  const entry = paths[route.path] ?? (paths[route.path] = {})
  entry[route.method.toLowerCase()] = { summary: route.summary, ...route.operation }
}

export default {
  openapi: '3.1.0',
  info: {
    title: 'DSH Web UI Marketplace API',
    version: '1.0.0',
    description: 'Edge API of dsh-market.com: vote counts, device-gated likes, Turnstile challenges and skin asset delivery for the DSH Web UI marketplace.',
  },
  servers: [{ url: 'https://dsh-market.com' }],
  paths,
}
