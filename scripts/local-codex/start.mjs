import { startBridge } from './server.mjs';
startBridge().catch(error=>{console.error(error.message);process.exitCode=1;});
