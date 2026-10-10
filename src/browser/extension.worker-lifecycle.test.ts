import { expect,it } from 'vitest';
it('each worker restart increments a persisted sequence without incrementing on reconnect',async()=>{
 const { recordWorkerStart }=await import(/* @vite-ignore */ new URL('../../chrome-extension/diagnostic-worker.js',import.meta.url).href);
 let stored={workerStartSequence:7};
 const storage={get:async()=>stored,set:async(v:typeof stored)=>{stored={...stored,...v}}};
 const first=await recordWorkerStart({storage:{local:storage}},1000);
 expect(first).toEqual({startedAt:1000,startSequence:8});
 expect(stored.workerStartSequence).toBe(8);
 const second=await recordWorkerStart({storage:{local:storage}},2000);
 expect(second).toEqual({startedAt:2000,startSequence:9});
});
