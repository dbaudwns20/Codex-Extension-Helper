import assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface TestDiagnostics {
  readonly comparisonCount: number;
  readonly renderedComparisonCount: number;
  readonly activeFileHasChanges: boolean;
}

interface TestExtensionApi {
  readonly testDiagnostics: TestDiagnostics;
  simulateExternalChange(
    uri: vscode.Uri,
    baselineText: string,
    currentText: string,
    lifecycle?: 'existing' | 'created',
  ): Promise<void>;
}

async function waitFor(
  description: string,
  predicate: () => boolean | PromiseLike<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`Timed out waiting for ${description}`);
}

async function waitForReview(
  diagnostics: TestDiagnostics,
  description: string,
): Promise<void> {
  await waitFor(description, () => (
    diagnostics.comparisonCount === 1
    && diagnostics.renderedComparisonCount === 1
    && diagnostics.activeFileHasChanges
  ));
}

async function waitForCleared(
  diagnostics: TestDiagnostics,
  description: string,
): Promise<void> {
  await waitFor(description, () => (
    diagnostics.comparisonCount === 0
    && diagnostics.renderedComparisonCount === 0
    && !diagnostics.activeFileHasChanges
  ));
}

async function hunkCommand(
  document: vscode.TextDocument,
  commandId: 'codexExtensionHelper.approveHunk' | 'codexExtensionHelper.rejectHunk',
): Promise<vscode.Command> {
  let found: vscode.Command | undefined;
  let signature: string | undefined;
  let stableSince = 0;
  await waitFor(`${commandId} CodeLens`, async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      document.uri,
    );
    found = lenses?.find((lens) => lens.command?.command === commandId)?.command;
    if (found === undefined) {
      signature = undefined;
      stableSince = 0;
      return false;
    }
    const nextSignature = JSON.stringify(found.arguments ?? []);
    if (nextSignature !== signature) {
      signature = nextSignature;
      stableSince = Date.now();
      return false;
    }
    return Date.now() - stableSince >= 300;
  });
  assert.ok(found, `${commandId} must be provided by the active comparison`);
  return found;
}

async function execute(command: vscode.Command): Promise<void> {
  await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
}

export async function runExtensionSmokeTest(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The Extension Host must open the temporary workspace');
  const fixtureNames = [
    'approve.ts',
    'reject.ts',
    'approve-all.ts',
    'reject-all.ts',
    'save.ts',
    'delete.ts',
    'eof-approve.ts',
    'eof-reject.ts',
  ];
  const fixtureDocuments = new Map(await Promise.all(fixtureNames.map(async (name) => {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, name);
    return [name, await vscode.workspace.openTextDocument(uri)] as const;
  })));
  await vscode.window.showTextDocument(fixtureDocuments.get('approve.ts')!);
  const extension = vscode.extensions.getExtension<TestExtensionApi>('local.codex-extension-helper');
  assert.ok(extension, 'The development extension must be installed');
  const api = await extension.activate();
  assert.ok(api?.testDiagnostics, 'Test diagnostics must be exported in the Extension Host test');
  const diagnostics = api.testDiagnostics;

  const openFixture = async (name: string) => {
    const document = fixtureDocuments.get(name);
    assert.ok(document, `The ${name} fixture must be pre-opened before extension activation`);
    const uri = document.uri;
    const editor = await vscode.window.showTextDocument(document);
    return { uri, document, editor };
  };
  const simulateReview = async (
    fixture: Awaited<ReturnType<typeof openFixture>>,
    baselineText: string,
    currentText: string,
    description: string,
  ) => {
    await vscode.workspace.fs.writeFile(fixture.uri, new TextEncoder().encode(currentText));
    await waitFor(`${description} buffer refresh`, () => fixture.document.getText() === currentText);
    await api.simulateExternalChange(fixture.uri, baselineText, currentText);
    await waitForReview(diagnostics, description);
  };

  const approve = await openFixture('approve.ts');
  await simulateReview(
    approve,
    'const value = 1;',
    'const value = 2;',
    'Approve comparison to be stored, rendered, and active',
  );

  await execute(await hunkCommand(approve.document, 'codexExtensionHelper.approveHunk'));
  await waitForCleared(diagnostics, 'Approve to clear comparison UI and title context');
  assert.equal(approve.document.getText(), 'const value = 2;', 'Approve must keep the current source text');
  assert.equal(approve.document.isDirty, false, 'Approve must not save or dirty the externally changed file');

  const reject = await openFixture('reject.ts');
  await simulateReview(
    reject,
    'const reject = "alpha-one-omega-two-end";',
    'const reject = "ALPHA-one-omega-TWO-end";',
    'Reject comparison to be stored, rendered, and active',
  );

  await execute(await hunkCommand(reject.document, 'codexExtensionHelper.rejectHunk'));
  await waitForCleared(diagnostics, 'Reject to clear comparison UI and title context');
  assert.equal(
    reject.document.getText(),
    'const reject = "alpha-one-omega-two-end";',
    'Reject must restore two separated spans from the latest baseline',
  );
  assert.equal(reject.document.isDirty, true, 'Reject must leave its baseline-restoring edit unsaved');

  const approveAll = await openFixture('approve-all.ts');
  await simulateReview(
    approveAll,
    'const value = 20;',
    'const value = 21;',
    'Approve All comparison to become active',
  );
  await vscode.commands.executeCommand('codexExtensionHelper.approveAll', approveAll.uri);
  await waitForCleared(diagnostics, 'Approve All to clear comparison UI and title context');
  assert.equal(approveAll.document.getText(), 'const value = 21;', 'Approve All must keep the current source text');

  const rejectAll = await openFixture('reject-all.ts');
  await simulateReview(
    rejectAll,
    'const rejectAll = "red-middle-blue-tail";',
    'const rejectAll = "RED-middle-BLUE-tail";',
    'Reject All comparison to become active',
  );
  await vscode.commands.executeCommand('codexExtensionHelper.rejectAll', rejectAll.uri);
  await waitForCleared(diagnostics, 'Reject All to clear comparison UI and title context');
  assert.equal(
    rejectAll.document.getText(),
    'const rejectAll = "red-middle-blue-tail";',
    'Reject All must restore two separated spans from the latest baseline',
  );
  assert.equal(rejectAll.document.isDirty, true, 'Reject All must leave its baseline edit unsaved');

  const eofApprove = await openFixture('eof-approve.ts');
  await simulateReview(
    eofApprove,
    'export const eofApprove = true;',
    'export const eofApprove = true;\n',
    'EOF-newline Approve comparison to become active',
  );
  await execute(await hunkCommand(eofApprove.document, 'codexExtensionHelper.approveHunk'));
  await waitForCleared(diagnostics, 'EOF-newline Approve to clear comparison UI and title context');
  assert.equal(
    eofApprove.document.getText(),
    'export const eofApprove = true;\n',
    'Approve must retain the added final newline exactly',
  );

  const eofReject = await openFixture('eof-reject.ts');
  await simulateReview(
    eofReject,
    'export const first = 1;\r\nexport const eofReject = true;\r\n',
    'export const first = 1;\r\nexport const eofReject = false;',
    'EOF-newline Reject comparison to become active',
  );
  await execute(await hunkCommand(eofReject.document, 'codexExtensionHelper.rejectHunk'));
  assert.equal(
    eofReject.document.getText(),
    'export const first = 1;\r\nexport const eofReject = true;\r\n',
    'Reject must restore changed EOF content and the CRLF terminator exactly',
  );
  await waitForCleared(diagnostics, 'EOF-newline Reject to clear comparison UI and title context');

  const saved = await openFixture('save.ts');
  await simulateReview(
    saved,
    'const value = 40;',
    'const value = 41;',
    'save-cleanup comparison to become active',
  );

  const edited = await saved.editor.edit((builder) => {
    builder.insert(saved.document.positionAt(saved.document.getText().length), '\n// saved\n');
  });
  assert.equal(edited, true, 'The source edit must apply before save');
  assert.equal(await saved.document.save(), true, 'The source document must save');
  await waitForCleared(diagnostics, 'save to clear comparison UI and title context');

  const deleted = await openFixture('delete.ts');
  await simulateReview(
    deleted,
    'const value = 50;',
    'const value = 51;',
    'delete-cleanup comparison to become active',
  );
  await vscode.workspace.fs.delete(deleted.uri);
  await waitForCleared(diagnostics, 'file deletion to clear comparison UI and title context');

  const createdUri = vscode.Uri.joinPath(workspaceFolder.uri, 'created.ts');
  await vscode.workspace.fs.writeFile(createdUri, new TextEncoder().encode('export const created = true;\n'));
  const createdDocument = await vscode.workspace.openTextDocument(createdUri);
  await vscode.window.showTextDocument(createdDocument);
  await api.simulateExternalChange(
    createdUri,
    '',
    'export const created = true;\n',
    'created',
  );
  await waitForReview(diagnostics, 'created-file comparison to become active');

  await vscode.commands.executeCommand('codexExtensionHelper.rejectAll', createdUri);
  await waitForCleared(diagnostics, 'created-file Reject All to clear UI and title context');
  await assert.rejects(
    async () => vscode.workspace.fs.stat(createdUri),
    'Reject All must remove a created file through the trash-capable host adapter',
  );
}
