// Static checks of the native shell skeleton (Academic OS P1-T2 step 2). Run: node --test apps/native/test/static-checks.test.mjs
// Nothing native is built here (no Xcode, Android SDK or signing material in this container).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConfig, checkNative, checkPackage, checkWorkflow } from '../scripts/check-native.mjs';

describe('native skeleton', () => {
  it('the committed config, package and workflows pass every static check', async () => {
    assert.deepEqual(await checkNative(), []);
  });

  it('the config check refuses a remote app, cleartext, mixed content and a bad id', () => {
    const good = { appId: 'ai.medlevo.app', appName: 'MedLevo', webDir: '../web/dist', server: { androidScheme: 'https' }, android: { allowMixedContent: false } };
    assert.deepEqual(checkConfig(good), []);
    assert.match(checkConfig({ ...good, server: { ...good.server, url: 'http://192.168.1.2:5173' } }).join('\n'), /server\.url/);
    assert.match(checkConfig({ ...good, server: { androidScheme: 'http' } }).join('\n'), /androidScheme/);
    assert.match(checkConfig({ ...good, server: { ...good.server, cleartext: true } }).join('\n'), /cleartext/);
    assert.match(checkConfig({ ...good, android: { allowMixedContent: true } }).join('\n'), /allowMixedContent/);
    assert.match(checkConfig({ ...good, appId: 'MedLevo' }).join('\n'), /appId/);
    assert.match(checkConfig({ ...good, webDir: 'www' }).join('\n'), /webDir/);
    assert.match(checkConfig({ ...good, bundledWebRuntime: true }).join('\n'), /unknown key/);
  });

  it('the package check refuses a workspace shell and mixed Capacitor majors', () => {
    const pkg = { private: true, dependencies: { '@capacitor/core': '^7.0.0', '@capacitor/ios': '^7.0.0', '@capacitor/android': '^7.0.0' }, devDependencies: { '@capacitor/cli': '^7.0.0' } };
    assert.deepEqual(checkPackage(pkg, { workspaces: ['apps/web'] }), []);
    assert.match(checkPackage(pkg, { workspaces: ['apps/*'] }).join('\n'), /workspace/);
    assert.match(checkPackage({ ...pkg, dependencies: { ...pkg.dependencies, '@capacitor/ios': '^6.0.0' } }, {}).join('\n'), /different majors/);
    assert.match(checkPackage({ ...pkg, private: false }, {}).join('\n'), /private/);
  });

  it('the workflow check refuses push triggers, write tokens, unpinned actions and literal keys', () => {
    const wf = {
      on: { workflow_dispatch: {} },
      permissions: { contents: 'read' },
      jobs: {
        'static-checks': { 'runs-on': 'ubuntu-24.04', steps: [{ uses: 'actions/checkout@v4' }] },
        build: { needs: 'static-checks', 'runs-on': 'macos-15', steps: [{ run: 'xcodebuild' }] },
      },
    };
    assert.deepEqual(checkWorkflow('ios.yml', wf, 'ios'), []);
    assert.match(checkWorkflow('ios.yml', { ...wf, on: { push: {}, workflow_dispatch: {} } }, 'ios').join('\n'), /only when asked/);
    assert.match(checkWorkflow('ios.yml', { ...wf, permissions: { contents: 'write' } }, 'ios').join('\n'), /permissions/);
    assert.match(checkWorkflow('ios.yml', { ...wf, jobs: { ...wf.jobs, build: { ...wf.jobs.build, 'runs-on': 'ubuntu-24.04' } } }, 'ios').join('\n'), /macOS/);
    assert.match(checkWorkflow('ios.yml', { ...wf, jobs: { ...wf.jobs, 'static-checks': { 'runs-on': 'ubuntu-24.04', steps: [{ uses: 'actions/checkout@main' }] } } }, 'ios').join('\n'), /unpinned/);
    assert.match(checkWorkflow('a.yml', { ...wf, jobs: { ...wf.jobs, build: { ...wf.jobs.build, 'runs-on': 'ubuntu-24.04', steps: [{ run: 'x', env: { password: 'hunter2' } }] } } }, 'android').join('\n'), /literal signing/);
  });
});
