import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * C# ASP.NET Core HTTP plugin. Handles:
 *   - Provider: `[Route("prefix")]` class + `[HttpGet/HttpPost/...]` methods
 *   - Provider: `[Route("template")]` on individual methods
 *   - Expands `[controller]` and `[action]` tokens in route templates
 *
 * Supports both source-scan and graph-assisted paths.
 */

const HTTP_METHOD_ATTRS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
  HttpOptions: 'OPTIONS',
  HttpHead: 'HEAD',
};

// ─── Provider: class-level [Route("prefix")] ─────────────────────────
const CLASS_ROUTE_PATTERNS = compilePatterns({
  name: 'csharp-class-route',
  language: CSharp,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          (attribute_list
            (attribute
              name: (identifier) @attr_name (#eq? @attr_name "Route")
              (attribute_argument_list
                (attribute_argument
                  (string_literal) @prefix))))
          name: (identifier) @class_name) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: method-level [HttpGet/HttpPost("path")] ───────────────
const METHOD_ROUTE_PATTERNS = compilePatterns({
  name: 'csharp-method-route',
  language: CSharp,
  patterns: [
    {
      meta: {},
      query: `
        (method_declaration
          (attribute_list
            (attribute
              name: (identifier) @http_attr (#match? @http_attr "^Http(Get|Post|Put|Delete|Patch|Head|Options)$")
              (attribute_argument_list
                (attribute_argument
                  (string_literal) @path))))
          name: (identifier) @method_name) @method
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: method-level [HttpGet] without path (convention-based) ─
const METHOD_NO_PATH_PATTERNS = compilePatterns({
  name: 'csharp-method-no-path',
  language: CSharp,
  patterns: [
    {
      meta: {},
      query: `
        (method_declaration
          (attribute_list
            (attribute
              name: (identifier) @http_attr (#match? @http_attr "^Http(Get|Post|Put|Delete|Patch|Head|Options)$")))
          name: (identifier) @method_name) @method
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: method-level [Route("path")] with verb ────────────────
const METHOD_ROUTE_ATTR_PATTERNS = compilePatterns({
  name: 'csharp-method-route-attr',
  language: CSharp,
  patterns: [
    {
      meta: {},
      query: `
        (method_declaration
          (attribute_list
            (attribute
              name: (identifier) @attr_name (#eq? @attr_name "Route")
              (attribute_argument_list
                (attribute_argument
                  (string_literal) @path))))
          name: (identifier) @method_name) @method
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

function stripControllerSuffix(name: string): string {
  return name.replace(/Controller$/, '');
}

function joinPath(prefix: string, suffix: string): string {
  const p = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const s = suffix.replace(/^\/+/, '');
  if (!p) return `/${s}`;
  if (!s) return `/${p}`;
  return `/${p}/${s}`;
}

function expandRouteTemplate(template: string, controllerName: string, actionName: string): string {
  let result = template;
  result = result.replace(/\[controller\]/g, stripControllerSuffix(controllerName));
  result = result.replace(/\[action\]/g, actionName);
  return result;
}

export const CSHARP_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'csharp-http',
  language: CSharp,
  scan(tree) {
    const out: HttpDetection[] = [];

    // Collect class-level [Route] prefixes
    const prefixByClassId = new Map<number, { prefix: string; className: string }>();
    for (const match of runCompiledPatterns(CLASS_ROUTE_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const classNode = match.captures.class;
      const classNameNode = match.captures.class_name;
      if (!prefixNode || !classNode || !classNameNode) continue;
      const rawPrefix = unquoteLiteral(prefixNode.text);
      if (rawPrefix !== null) {
        prefixByClassId.set(classNode.id, { prefix: rawPrefix, className: classNameNode.text });
      }
    }

    // Track which method nodes we already handled via [HttpGet("path")]
    const handledMethodIds = new Set<number>();

    // Method-level [HttpGet("path")] / [HttpPost("path")]
    for (const match of runCompiledPatterns(METHOD_ROUTE_PATTERNS, tree)) {
      const httpAttrNode = match.captures.http_attr;
      const pathNode = match.captures.path;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!httpAttrNode || !pathNode || !methodNode) continue;

      const httpMethod = HTTP_METHOD_ATTRS[httpAttrNode.text];
      if (!httpMethod) continue;

      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      const enclosingClass = findEnclosingClass(methodNode);
      let prefix = '';
      let className = '';
      if (enclosingClass) {
        const info = prefixByClassId.get(enclosingClass.id);
        if (info) {
          prefix = info.prefix;
          className = info.className;
        }
      }

      const methodPath = expandRouteTemplate(rawPath, className, nameNode?.text ?? '');
      const fullPath = prefix
        ? expandRouteTemplate(joinPath(prefix, methodPath), className, nameNode?.text ?? '')
        : methodPath;

      handledMethodIds.add(methodNode.id);
      out.push({
        role: 'provider',
        framework: 'aspnetcore',
        method: httpMethod,
        path: fullPath.startsWith('/') ? fullPath : `/${fullPath}`,
        name: nameNode?.text ?? null,
        confidence: 0.8,
      });
    }

    // Method-level [HttpGet] without path (use action name)
    for (const match of runCompiledPatterns(METHOD_NO_PATH_PATTERNS, tree)) {
      const httpAttrNode = match.captures.http_attr;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!httpAttrNode || !methodNode) continue;
      if (handledMethodIds.has(methodNode.id)) continue;

      const httpMethod = HTTP_METHOD_ATTRS[httpAttrNode.text];
      if (!httpMethod) continue;

      const enclosingClass = findEnclosingClass(methodNode);
      let prefix = '';
      let className = '';
      if (enclosingClass) {
        const info = prefixByClassId.get(enclosingClass.id);
        if (info) {
          prefix = info.prefix;
          className = info.className;
        }
      }

      const actionName = nameNode?.text ?? '';
      let fullPath: string;
      if (prefix) {
        // Check the ORIGINAL template for [action] — if it's present,
        // expandRouteTemplate already substitutes the action name.
        // Appending it again would duplicate the last segment.
        if (prefix.includes('[action]')) {
          fullPath = expandRouteTemplate(prefix, className, actionName);
        } else {
          const expandedPrefix = expandRouteTemplate(prefix, className, actionName);
          fullPath = joinPath(expandedPrefix, actionName);
        }
      } else {
        fullPath = `/${actionName}`;
      }

      out.push({
        role: 'provider',
        framework: 'aspnetcore',
        method: httpMethod,
        path: fullPath.startsWith('/') ? fullPath : `/${fullPath}`,
        name: nameNode?.text ?? null,
        confidence: 0.7,
      });
    }

    // Method-level [Route("path")] without verb attribute
    for (const match of runCompiledPatterns(METHOD_ROUTE_ATTR_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!pathNode || !methodNode) continue;
      if (handledMethodIds.has(methodNode.id)) continue;

      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      const enclosingClass = findEnclosingClass(methodNode);
      let prefix = '';
      let className = '';
      if (enclosingClass) {
        const info = prefixByClassId.get(enclosingClass.id);
        if (info) {
          prefix = info.prefix;
          className = info.className;
        }
      }

      const methodPath = expandRouteTemplate(rawPath, className, nameNode?.text ?? '');
      const fullPath = prefix
        ? expandRouteTemplate(joinPath(prefix, methodPath), className, nameNode?.text ?? '')
        : methodPath;

      out.push({
        role: 'provider',
        framework: 'aspnetcore',
        method: 'GET',
        path: fullPath.startsWith('/') ? fullPath : `/${fullPath}`,
        name: nameNode?.text ?? null,
        confidence: 0.6,
      });
    }

    return out;
  },
};
