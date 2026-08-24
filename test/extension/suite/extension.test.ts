import assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface TestDiagnostics {
  readonly comparisonCount: number;
  readonly renderedComparisonCount: number;
}

interface TestExtensionApi {
  readonly testDiagnostics: TestDiagnostics;
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`Timed out waiting for ${description}`);
}

export async function runExtensionSmokeTest(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The Extension Host must open the temporary workspace');
  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, 'smoke.ts');
  const document = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension<TestExtensionApi>('local.codex-extension-helper');
  assert.ok(extension, 'The development extension must be installed');
  const api = await extension.activate();
  assert.ok(api?.testDiagnostics, 'Test diagnostics must be exported in the Extension Host test');

  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode('const value = 2;\n'));
  await waitFor('the external comparison to be stored and rendered', () => (
    api.testDiagnostics.comparisonCount === 1
    && api.testDiagnostics.renderedComparisonCount === 1
  ));

  const edited = await editor.edit((builder) => {
    builder.insert(new vscode.Position(document.lineCount, 0), '// saved\n');
  });
  assert.equal(edited, true, 'The smoke document edit must apply before save');
  assert.equal(await document.save(), true, 'The smoke document must save');
  await waitFor('save to clear the comparison', () => (
    api.testDiagnostics.comparisonCount === 0
    && api.testDiagnostics.renderedComparisonCount === 0
  ));

  const policyUri = vscode.Uri.joinPath(workspaceFolder.uri, 'policy.ts');
  const policyDocument = await vscode.workspace.openTextDocument(policyUri);
  const policyEditor = await vscode.window.showTextDocument(policyDocument);
  assert.ok(
    Buffer.byteLength(policyDocument.getText(), 'utf8') > 1024,
    'The policy fixture must start above the initial one-KiB limit',
  );

  await vscode.workspace.getConfiguration('codexExtensionHelper').update(
    'maxFileSizeKb',
    2,
    vscode.ConfigurationTarget.Workspace,
  );
  const externallyChangedPolicyText = policyDocument.getText().replace(/x";\n$/u, 'y";\n');
  assert.notEqual(
    externallyChangedPolicyText,
    policyDocument.getText(),
    'The policy fixture replacement must change one byte',
  );
  await vscode.workspace.fs.writeFile(
    policyUri,
    new TextEncoder().encode(externallyChangedPolicyText),
  );
  await waitFor('the newly eligible open document to compare on its next external write', () => (
    api.testDiagnostics.comparisonCount === 1
    && api.testDiagnostics.renderedComparisonCount === 1
  ));

  const policyEdited = await policyEditor.edit((builder) => {
    builder.insert(new vscode.Position(policyDocument.lineCount, 0), '// saved\n');
  });
  assert.equal(policyEdited, true, 'The policy document edit must apply before save');
  assert.equal(await policyDocument.save(), true, 'The policy document must save');
  await waitFor('the policy document save to clear the comparison', () => (
    api.testDiagnostics.comparisonCount === 0
    && api.testDiagnostics.renderedComparisonCount === 0
  ));
}
