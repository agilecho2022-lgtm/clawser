import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function extensionPath(file: string): string {
  const assetPath = resolve(process.cwd(), "assets/chrome-extension", file);
  return existsSync(assetPath) ? assetPath : resolve(process.cwd(), "chrome-extension", file);
}

function readBackgroundWorker(): ts.SourceFile {
  return ts.createSourceFile(
    "background.js",
    readFileSync(extensionPath("background.js"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) {
      result.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function functionBody(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = nodes(source, ts.isFunctionDeclaration).find((node) => node.name?.text === name);
  if (!fn) {
    throw new Error(`Missing worker function: ${name}`);
  }
  return fn;
}

function methodGuard(source: ts.SourceFile, method: string): ts.IfStatement {
  const guard = nodes(functionBody(source, "handleForwardCdpCommand"), ts.isIfStatement).find(
    (node) =>
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === "method" &&
      ts.isStringLiteral(node.expression.right) &&
      node.expression.right.text === method,
  );
  if (!guard) {
    throw new Error(`Missing worker method: ${method}`);
  }
  return guard;
}

function call(root: ts.Node, name: string): ts.CallExpression {
  const found = nodes(root, ts.isCallExpression).find(
    (node) => node.expression.getText().replace(/\s/g, "") === name,
  );
  if (!found) {
    throw new Error(`Missing worker call: ${name}`);
  }
  return found;
}

function expectAwaited(root: ts.Node, name: string) {
  expect(ts.isAwaitExpression(call(root, name).parent), name).toBe(true);
}

describe("chrome extension background worker", () => {
  it("allows Target.createTarget before requiring an attached tab", () => {
    const source = readBackgroundWorker();
    const missingGuard = nodes(
      functionBody(source, "handleForwardCdpCommand"),
      ts.isIfStatement,
    ).find(
      (node) =>
        ts.isPrefixUnaryExpression(node.expression) &&
        node.expression.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(node.expression.operand) &&
        node.expression.operand.text === "tabId",
    );
    expect(missingGuard).toBeDefined();
    expect(methodGuard(source, "Target.createTarget").pos).toBeLessThan(missingGuard!.pos);
    expect(methodGuard(source, "Clawser.attachActiveTab").pos).toBeLessThan(missingGuard!.pos);
    expect(nodes(missingGuard!, ts.isThrowStatement)).toHaveLength(1);
  });

  it("implements active-tab attach via chrome.tabs.query and attachTab", () => {
    const block = methodGuard(readBackgroundWorker(), "Clawser.attachActiveTab");
    const options = call(block, "chrome.tabs.query").arguments[0];
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    if (!ts.isObjectLiteralExpression(options)) {
      throw new Error("Expected tab query options");
    }
    for (const name of ["active", "currentWindow"]) {
      const prop = options.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === name,
      );
      expect(
        prop &&
          ts.isPropertyAssignment(prop) &&
          prop.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ).toBe(true);
    }
    for (const name of ["ensureRelayConnection", "reannounceAttachedTabs", "attachTabForRelay"]) {
      expectAwaited(block, name);
    }
    expect(call(block, "attachTabForRelay").arguments[0].getText()).toBe("tab");
  });

  it("implements URL and all-tab attach by querying Chrome tabs", () => {
    const source = readBackgroundWorker();
    const block = methodGuard(source, "Clawser.attachTabs");
    const options = call(block, "chrome.tabs.query").arguments[0];
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    if (!ts.isObjectLiteralExpression(options)) {
      throw new Error("Expected tab query options");
    }
    expect(options.properties).toHaveLength(0);
    expect(nodes(block, ts.isIdentifier).some((node) => node.text === "urlContains")).toBe(true);
    expectAwaited(block, "attachTabForRelay");
    const attach = call(functionBody(source, "attachTabForRelay"), "attachTab");
    expect(ts.isAwaitExpression(attach.parent)).toBe(true);
    expect(attach.arguments[0].getText()).toBe("tab.id");
  });

  it("auto-attaches tabs opened by an already attached tab", () => {
    const source = readBackgroundWorker();
    const helper = functionBody(source, "autoAttachOpenedTab");
    const listener = call(source, "chrome.tabs.onCreated.addListener");
    const wrapper = call(listener, "whenReady");
    expect(ts.isVoidExpression(wrapper.parent)).toBe(true);
    expect(call(wrapper, "autoAttachOpenedTab").arguments[0].getText()).toBe("tab");
    expect(nodes(helper, ts.isIdentifier).some((node) => node.text === "openerTabId")).toBe(true);
    expect(
      nodes(helper, ts.isBinaryExpression).some(
        (node) =>
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
          node.left.getText().replace(/\s/g, "") === "tabs.get(openerTabId)?.state" &&
          ts.isStringLiteral(node.right) &&
          node.right.text === "connected",
      ),
    ).toBe(true);
    expectAwaited(helper, "attachTabForRelay");
    expectAwaited(helper, "reannounceAttachedTabs");
  });

  it("connects the relay on startup before checking for attached tabs", () => {
    const initializer = call(readBackgroundWorker(), "initPromise.then");
    const connect = call(initializer, "ensureRelayConnection");
    const guard = nodes(initializer, ts.isIfStatement).find(
      (node) =>
        ts.isBinaryExpression(node.expression) &&
        node.expression.left.getText().replace(/\s/g, "") === "tabs.size" &&
        node.expression.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
        ts.isNumericLiteral(node.expression.right) &&
        node.expression.right.text === "0",
    );
    expect(guard).toBeDefined();
    expect(connect.pos).toBeLessThan(guard!.pos);
    expect(call(initializer, "ensureRelayConnection().then")).toBeDefined();
  });
});
