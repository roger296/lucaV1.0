import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { validateAccessToken } from '../engine/oauth';
import { registerTools, type McpServer } from './tools';

// ---------------------------------------------------------------------------
// MCP HTTP Server — JSON-RPC 2.0 over HTTP (stateless)
//
// POST /mcp   Authorization: Bearer <token>
//             Content-Type: application/json
//             Body: JSON-RPC 2.0 request object
// GET  /mcp   Returns server info (used by Claude to verify endpoint exists)
// ---------------------------------------------------------------------------

export const mcpRouter = Router();

// ── JSON-RPC types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: string | number | null | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ── Tool registry ─────────────────────────────────────────────────────────

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

const toolRegistry = new Map<string, ToolEntry>();

// Build a JSON Schema property descriptor from a Zod type.
//
// Recursively handles nested ZodArray(ZodObject), ZodRecord, ZodDefault,
// ZodEffects, etc. The previous implementation flattened all arrays to
// items={type:'string'} and all objects to {type:'object'} with no properties,
// which produced wildly incorrect tools/list output and broke every AI agent
// that tried to post opening balances, manual journals, or bulk transactions.
function zodToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (zodType as any)._def as Record<string, unknown>;
  const typeName = (def?.['typeName'] as string) ?? '';
  const description = (def?.['description'] as string | undefined);

  let schema: Record<string, unknown>;

  switch (typeName) {
    case 'ZodString':
      schema = { type: 'string' };
      break;
    case 'ZodNumber':
      schema = { type: 'number' };
      break;
    case 'ZodBoolean':
      schema = { type: 'boolean' };
      break;
    case 'ZodEnum': {
      const values = (def?.['values'] as string[]) ?? [];
      schema = { type: 'string', enum: values };
      break;
    }
    case 'ZodArray': {
      // Recurse into the element type so array-of-objects serialises correctly.
      const element = def?.['type'] as z.ZodTypeAny | undefined;
      schema = {
        type: 'array',
        items: element ? zodToJsonSchema(element) : { type: 'string' },
      };
      break;
    }
    case 'ZodObject': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shapeFn = def?.['shape'] as (() => Record<string, z.ZodTypeAny>) | undefined;
      const shape = typeof shapeFn === 'function' ? shapeFn() : {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      schema = { type: 'object', properties };
      if (required.length > 0) schema['required'] = required;
      break;
    }
    case 'ZodRecord': {
      const valueType = def?.['valueType'] as z.ZodTypeAny | undefined;
      schema = {
        type: 'object',
        additionalProperties: valueType ? zodToJsonSchema(valueType) : true,
      };
      break;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodEffects':
    case 'ZodBranded':
    case 'ZodReadonly':
    case 'ZodCatch': {
      const inner = (def?.['innerType'] ?? def?.['schema']) as z.ZodTypeAny | undefined;
      schema = inner ? zodToJsonSchema(inner) : { type: 'string' };
      break;
    }
    case 'ZodUnion': {
      const options = (def?.['options'] as z.ZodTypeAny[]) ?? [];
      schema = { anyOf: options.map((o) => zodToJsonSchema(o)) };
      break;
    }
    case 'ZodLiteral': {
      const value = def?.['value'];
      const jsType = typeof value;
      schema = { type: jsType === 'number' ? 'number' : jsType === 'boolean' ? 'boolean' : 'string', enum: [value] };
      break;
    }
    case 'ZodAny':
    case 'ZodUnknown':
      schema = {};
      break;
    default:
      schema = { type: 'string' };
  }

  if (description && !schema['description']) schema['description'] = description;
  return schema;
}

function isOptional(zodType: z.ZodTypeAny): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (zodType as any)._def as Record<string, unknown> | undefined;
  const typeName = (def?.['typeName'] as string) ?? '';
  if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault') {
    return true;
  }
  // Unwrap effects/branded/readonly wrappers to check inner.
  if (typeName === 'ZodEffects' || typeName === 'ZodBranded' || typeName === 'ZodReadonly' || typeName === 'ZodCatch') {
    const inner = (def?.['innerType'] ?? def?.['schema']) as z.ZodTypeAny | undefined;
    return inner ? isOptional(inner) : false;
  }
  return false;
}

// Implement the McpServer interface so TypeScript is satisfied
const stubServer: McpServer = {
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
  ): void {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, zodType] of Object.entries(schema)) {
      properties[key] = zodToJsonSchema(zodType);
      if (!isOptional(zodType)) required.push(key);
    }

    toolRegistry.set(name, {
      name,
      description,
      inputSchema: { type: 'object', properties, required },
      handler,
    });
  },
};

// Populate registry at module load time
registerTools(stubServer);

// ── Request dispatcher ────────────────────────────────────────────────────

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params = {} } = req;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'luca-general-ledger', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return ok(id, null);

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: Array.from(toolRegistry.values()).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const toolName = params['name'] as string | undefined;
      let args = params['arguments'] ?? {};
      if (typeof args === 'string') {
        args = JSON.parse(args);
      }
      const typedArgs = args as Record<string, unknown>;

      if (!toolName) return err(id, -32602, 'Missing tool name');

      const tool = toolRegistry.get(toolName);
      if (!tool) return err(id, -32602, `Unknown tool: ${toolName}`);

      try {
        const result = await tool.handler(typedArgs);
        return ok(id, result);
      } catch (e) {
        return err(id, -32603, e instanceof Error ? e.message : 'Tool execution failed');
      }
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────

// ── Shared auth helper ────────────────────────────────────────────────────

// RFC 6750 §3 — points to the MCP-specific protected resource metadata so
// Claude discovers "resource": "https://gl.tbv-3pl.com/mcp" (not the root).
// This ensures the resource Claude binds to in the authorize request matches
// the MCP endpoint URL, allowing it to verify the callback and call /oauth/token.
function mcpWwwAuthenticate(): string {
  return [
    `Bearer realm="${config.baseUrl}"`,
    `scope="ledger:read ledger:write"`,
    `resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
  ].join(', ');
}

// GET /mcp — must also return 401 when unauthenticated so Claude receives the
// WWW-Authenticate header and starts the OAuth discovery flow correctly.
mcpRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const authHeader = (req.headers['authorization'] as string) ?? '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!rawToken) {
    console.log('[mcp] GET 401 — no Bearer token. User-Agent:', req.headers['user-agent']);
    res
      .status(401)
      .set('WWW-Authenticate', mcpWwwAuthenticate())
      .json({ error: 'unauthorized', error_description: 'Bearer token required' });
    return;
  }

  const session = await validateAccessToken(rawToken);
  if (!session) {
    res
      .status(401)
      .set('WWW-Authenticate', mcpWwwAuthenticate())
      .json({ error: 'unauthorized', error_description: 'Invalid or expired token' });
    return;
  }

  res.json({
    name: 'luca-general-ledger',
    version: '1.0.0',
    description: 'Luca General Ledger MCP Server',
    tools: toolRegistry.size,
  });
});

// POST /mcp — main JSON-RPC endpoint
mcpRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // Authenticate via Bearer token
  const authHeader = (req.headers['authorization'] as string) ?? '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!rawToken) {
    console.log('[mcp] 401 — no Bearer token. User-Agent:', req.headers['user-agent']);
    res
      .status(401)
      .set('WWW-Authenticate', mcpWwwAuthenticate())
      .json({ error: 'unauthorized', error_description: 'Bearer token required' });
    return;
  }

  const session = await validateAccessToken(rawToken);
  if (!session) {
    res
      .status(401)
      .set('WWW-Authenticate', mcpWwwAuthenticate())
      .json({ error: 'unauthorized', error_description: 'Invalid or expired token' });
    return;
  }

  // Parse body
  const body = req.body as JsonRpcRequest | JsonRpcRequest[] | null;
  if (!body) {
    res.json(err(null, -32700, 'Empty request body'));
    return;
  }

  // Handle batch
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(dispatch));
    res.json(responses);
    return;
  }

  res.json(await dispatch(body));
});
