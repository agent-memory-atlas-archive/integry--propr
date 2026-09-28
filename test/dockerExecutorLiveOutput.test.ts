import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const writes: string[] = [];
class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval(_script: string, _keys: number, _data: string, _meta: string, text: string) {
        writes.push(text);
        return text.length;
    }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');

test('a streamed execution publishes stderr diagnostics without splitting an unfinished stdout record', async () => {
    const record = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code' }] } });
    const script = `
        const wait = ms => new Promise(done => setTimeout(done, ms));
        (async () => {
            process.stdout.write(${JSON.stringify(record.slice(0, 20))});
            await wait(150);
            process.stderr.write('warning: slow network\\n');
            await wait(150);
            process.stdout.write(${JSON.stringify(`${record.slice(20)}\n`)});
        })();`;
    await executeDockerCommand(process.execPath, ['-e', script], { taskId: 'docker-sources', streamToRedis: true, streamStderrToRedis: true, timeout: 10_000 });
    assert.deepEqual(writes.join('').split('\n').filter(Boolean).sort(), [record, 'warning: slow network'].sort());
});

test('a streamed execution drops a newline-free record past the bound instead of buffering it', async () => {
    writes.length = 0;
    const script = `
        const wait = ms => new Promise(done => setTimeout(done, ms));
        (async () => {
            process.stdout.write('before\\n');
            for (let index = 0; index < 48; index += 1) { process.stdout.write('x'.repeat(64 * 1024)); await wait(1); }
            process.stdout.write('\\nafter\\n');
        })();`;
    await executeDockerCommand(process.execPath, ['-e', script], { taskId: 'docker-oversized', streamToRedis: true, timeout: 10_000 });
    assert.deepEqual(writes.join('').split('\n'), ['before', 'after', '']);
});
