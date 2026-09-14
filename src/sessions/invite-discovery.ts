import type { SessionStore } from "../ports/session-store.ts";
import type { FeishuOrganizerLookup, OrganizerResolution } from "../ports/feishu.ts";

/** One explicit tick; the later application owns scheduling. No bridge/runtime launch. */
export function createInviteDiscovery(options: {
  readonly store: SessionStore; readonly metadata: FeishuOrganizerLookup;
  readonly now?: ()=>number; readonly jitter?: ()=>number;
  readonly attemptBudgetMs?: number; readonly closeBudgetMs?: number;
}) {
  const now=options.now ?? Date.now,jitter=options.jitter ?? Math.random;
  const attemptMs=options.attemptBudgetMs ?? 20000,closeMs=options.closeBudgetMs ?? 7000;
  if(!Number.isInteger(attemptMs)||attemptMs<2||attemptMs>20000||!Number.isInteger(closeMs)||closeMs<1||closeMs>7000) throw new Error("invalid_discovery_budget");
  let closed=false,running:Promise<boolean>|null=null,metadataWork:Promise<OrganizerResolution>|null=null,controller:AbortController|null=null;
  return {
    runOnce(): Promise<boolean> {
      if(closed) return Promise.reject(new Error("invite_discovery_closed"));
      if(running || metadataWork) return Promise.reject(new Error("invite_discovery_busy"));
      const claim=options.store.claimInviteMetadata(now());
      if(!claim) return Promise.resolve(false);
      controller=new AbortController(); const ownController=controller;
      const work=Promise.resolve().then(()=>options.metadata.resolve(claim,ownController.signal));
      metadataWork=work;
      // Leave a final quarter (up to5s) for abort settlement within the total budget.
      const abortTimer=setTimeout(()=>ownController.abort(),attemptMs-Math.min(5000,Math.floor(attemptMs/4)));
      let deadlineTimer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<OrganizerResolution>((resolve)=>{
        deadlineTimer=setTimeout(()=>{ownController.abort();resolve({status:"blocked",reason:"timeout",retryable:true});},attemptMs);
      });
      void work.then(()=>{if(metadataWork===work)metadataWork=null;},()=>{if(metadataWork===work)metadataWork=null;});
      running=(async()=>{
        let result:OrganizerResolution;
        try {result=await Promise.race([work,deadline]);}
        catch {result={status:"blocked",reason:ownController.signal.aborted?"cancelled":"metadata_unavailable",retryable:true};}
        if(ownController.signal.aborted && result.status === "resolved") result={status:"blocked",reason:"cancelled",retryable:true};
        const finish=now();
        if(result.status === "resolved") options.store.completeInviteClaim(claim,result,finish);
        else {
          const sample=jitter();
          const fraction=Number.isFinite(sample)?Math.max(0,Math.min(1,sample)):0;
          const cap=Math.min(60000,1000*2**Math.min(claim.generationAttempts,6));
          const delay=Math.max(1000,Math.floor(fraction*cap));
          options.store.failInviteClaim(claim,result,finish,delay);
        }
        return true;
      })().finally(()=>{clearTimeout(abortTimer);clearTimeout(deadlineTimer);running=null;controller=null;});
      return running;
    },
    async close(): Promise<boolean> {
      closed=true;controller?.abort();
      const owned=Promise.allSettled([...(running?[running]:[]),...(metadataWork?[metadataWork]:[])]);
      return new Promise<boolean>((resolve)=>{
        const timer=setTimeout(()=>resolve(false),closeMs);
        void owned.then(()=>{clearTimeout(timer);resolve(true);});
      });
    },
  };
}
