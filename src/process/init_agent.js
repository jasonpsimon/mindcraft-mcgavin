import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

// BT-bundle(b): Process exit reasons — structured [Exit] lines on every
// shutdown path. process.on('exit') is synchronous and fires once per
// process (clean, SIGINT, uncaught). The uncaught/rejection handlers
// explicitly process.exit(1) after logging so Node's default crash-exit
// code (which agent_process.js reads to decide whether to restart) is
// preserved — registering a listener otherwise suppresses the default
// and would let crashes silently exit 0.
process.on('exit', (code) => {
    console.log(`[Exit] event=process_exit code=${code}`);
});
process.on('uncaughtException', (err) => {
    const msg = String(err?.message ?? err).replace(/"/g, '\\"');
    const stack_head = (err?.stack?.split('\n')[1] ?? '').trim();
    console.log(`[Exit] event=uncaught err="${msg}" stack_head="${stack_head}"`);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const msg = (reason instanceof Error ? reason.message : String(reason)).replace(/"/g, '\\"');
    console.log(`[Exit] event=unhandled_rejection reason="${msg}"`);
    process.exit(1);
});

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
