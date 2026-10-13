import { EXTENSION_LIMITS } from '@propr/shared';
import { ExtensionError, ExtensionProfileStore } from './extensionProfileStore.js';
import { requestExtensionMcp, extensionResponseWireBytes } from './endpointPolicy.js';
import { redactExtensionOutput } from './extensionOutput.js';
export { redactExtensionOutput } from './extensionOutput.js';

export async function extensionGatewayCall(store: ExtensionProfileStore, token: string, serverName: string, body: unknown, send = requestExtensionMcp): Promise<unknown> {
  const { snapshot, secrets } = await store.grantSnapshot(token);
  // Failed/oversized requests consume the full reservation, so failures cannot
  // bypass the run budget. Successful responses charge actual wire bytes,
  // including whitespace that disappears during JSON parsing.
  let responseBytes: number = EXTENSION_LIMITS.responseBytes;
  try {
  const server = snapshot.mcpServers.find(s => s.enabled && s.name === serverName);
  if (!server || !body || typeof body !== 'object' || Array.isArray(body)) throw new ExtensionError(403, 'MCP capability unavailable');
  const rpc = body as Record<string, unknown>;
  if (rpc.jsonrpc !== '2.0' || Object.keys(rpc).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k)) || !(rpc.id === undefined || typeof rpc.id === 'string' || typeof rpc.id === 'number') || !['initialize', 'ping', 'notifications/initialized', 'tools/list', 'tools/call'].includes(String(rpc.method))) throw new ExtensionError(403, 'MCP method unavailable');
  const params = rpc.params as Record<string, unknown> | undefined;
  if (rpc.method === 'tools/call' && (!params || typeof params.name !== 'string' || !server.tools.includes(params.name) || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k)))) throw new ExtensionError(403, 'MCP tool unavailable');
  // Stateful upstream MCP is intentionally unsupported: no upstream session
  // headers/cookies or reverse requests can extend a run's capabilities.
  let upstream: unknown;
  const forwarded = rpc.method === 'tools/call' ? { ...rpc, params: { name: params!.name, ...(params!.arguments === undefined ? {} : { arguments: params!.arguments }) } } : rpc;
  try { upstream = await send(server.url, forwarded, secrets[serverName]); } catch { throw new ExtensionError(502, 'MCP connection failed'); }
  if (upstream === null && rpc.id === undefined) return null;
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) throw new ExtensionError(502, 'MCP protocol unavailable');
  responseBytes = extensionResponseWireBytes(upstream) ?? EXTENSION_LIMITS.responseBytes;
  const result = upstream as Record<string, unknown>;
  if (result.jsonrpc !== '2.0' || result.id !== rpc.id || result.error || !Object.hasOwn(result, 'result')) throw new ExtensionError(502, 'MCP request failed');
  let projection = result.result;
  if (rpc.method === 'initialize') {
    projection = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: server.name, version: '1' } };
  } else if (rpc.method === 'tools/list') {
    const tools = (projection as { tools?: unknown[] })?.tools;
    if (!Array.isArray(tools) || tools.length > 64) throw new ExtensionError(502, 'MCP tool catalog unavailable');
    projection = { tools: tools.filter(t => t && typeof t === 'object' && server.tools.includes(String((t as { name?: unknown }).name))) };
  }
  const redacted = redactExtensionOutput({ jsonrpc: '2.0', id: rpc.id, result: projection }, [...Object.values(secrets), token]);
  if (Buffer.byteLength(JSON.stringify(redacted)) > EXTENSION_LIMITS.responseBytes) throw new ExtensionError(502, 'MCP response too large');
  return redacted;
  } finally { await store.finishGatewayCall(token, responseBytes); }
}
