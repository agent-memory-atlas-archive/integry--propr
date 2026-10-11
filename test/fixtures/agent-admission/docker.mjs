// Docker lifecycle simulator. Redis is real; immutable IDs and create/start/
// remove races are exercised without a provider, Docker daemon or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const root = process.env.PROPR_TEST_ADMISSION_DOCKER;
const [command, ...args] = process.argv.slice(2);
const file = id => path.join(root, id + '.json');
const records = () => fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
if (command === 'info') console.log('test-daemon');
else if (command === 'create') {
    if (args.includes('fixture-fail-create')) { console.error(args.join(' ')); process.exit(1); }
    const id = randomBytes(32).toString('hex');
    fs.writeFileSync(file(id), JSON.stringify({ id, args, state: 'created' }));
    console.log(id);
} else if (command === 'start') {
    const id = args.at(-1);
    if (!fs.existsSync(file(id))) process.exit(1);
    const r = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    r.state = 'running';
    fs.writeFileSync(file(id), JSON.stringify(r));
    fs.appendFileSync(path.join(root, 'starts'), id + '\n');
    const timer = setInterval(() => {
        if (!fs.existsSync(file(id))) { clearInterval(timer); process.exit(0); }
        const state = JSON.parse(fs.readFileSync(file(id), 'utf8'));
        if (state.stop) { fs.unlinkSync(file(id)); clearInterval(timer); process.exit(0); }
    }, 10);
} else if (command === 'rm') {
    fs.rmSync(file(args.at(-1)), { force: true });
} else if (command === 'ps') {
    const filter = args[args.indexOf('--filter') + 1];
    for (const r of records()) if (filter === `id=${r.id}` || (filter?.startsWith('label=') && r.args.includes(filter.slice(6)))) console.log(r.id);
} else {
    console.error(`Unsupported fixture command: ${command}`);
    process.exit(1);
}
