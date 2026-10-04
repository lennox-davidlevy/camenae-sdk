import { createHash } from "node:crypto";

// Independent, preparation-only Bob 2.0.5 reporting correction. No accounting,
// permission, compaction, or model-selection policy is changed here.
// Input is the permission-corrected entrypoint; that correction stays untouched.
const id = "acp-session-usage-v1";

const inputSha256 = "d443d6e7e0351c45fc2191d63787835c96d15eace7a9bad0a6d795985295da8c";

const outputSha256 = "17eb21f1e836179d0fac0010ac65b488ea33f9ab552f59fa282c2dc819f46a75";

const reportUsage = `async notifyGatewayUsage(t){try{
  const {runtime,taskState,config}=t.runContext;
  const task=taskState.rootTask;
  const session=runtime.getConfig().session;
  const model=task.getModel()||session.model||QF();
  const resolved=runtime.bobGatewayUsageModelInfo;
  const info=resolved?.model===model?resolved.info:undefined;
  const spend=task.getSpend();
  const number=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null;
  const positive=value=>number(value)!==null&&value>0?value:null;
  const threshold=(session.compactionThresholdPercent??90)/100;
  const usage={version:1,contextTokens:number(spend.contextTokens),contextWindow:positive(info?.contextWindow),
    maxOutputTokens:positive(info?.maxOutputTokens),compactionThreshold:threshold>=0&&threshold<=1?threshold:null,
    autoCompact:session.autoCompact!==false,bobcoins:config.provider==="harness"?number(spend.cost):null};
  const meta={"bob-gateway/usage":usage};
  const update=usage.contextWindow!==null&&usage.contextTokens!==null
    ?{sessionUpdate:"usage_update",used:usage.contextTokens,size:usage.contextWindow,_meta:meta}
    :{sessionUpdate:"session_info_update",_meta:meta};
  await this.connection.notify(cE.client.session.update,{sessionId:taskState.rootTaskId,update});
}catch{/* Reporting must not replace a native prompt result or error. */}}`;

const replacements = [
  // Observe the native lookup result; reporting never initiates another lookup.
  // A different/failed lookup clears the last observation rather than inventing
  // a cache or presenting another model's capacity as the current limit.
  [
    'async getModelInfo(e){return this.options.providerSource.getModelInfo?.(e)}',
    'async getModelInfo(e){this.bobGatewayUsageModelInfo=undefined;const info=await this.options.providerSource.getModelInfo?.(e);this.bobGatewayUsageModelInfo={model:e,info};return info}',
  ],
  [
    'catch(p){if(!t.cancelled)throw p}await this.syncTaskMode(t);',
    'catch(p){if(!t.cancelled)throw p}finally{await this.notifyGatewayUsage(t)}await this.syncTaskMode(t);',
  ],
  [
    'async notifyAvailableCommands(t){let n=this.getCommandCatalog(t).availableCommands;',
    `${reportUsage}async notifyAvailableCommands(t){await this.notifyGatewayUsage(t);let n=this.getCommandCatalog(t).availableCommands;`,
  ],
];

export function correctBobUsage(source, bob) {
  if (bob.version !== "2.0.5" || bob.releaseCommit !== "2dc1809063bd2c2b550e66b5c20854f3cf8cb9f4"
    || bob.correction?.entrypointSha256 !== inputSha256 || bob.usageCorrection?.id !== id
    || bob.usageCorrection.entrypointSha256 !== outputSha256) throw new Error("Review the Bob usage correction before changing its pins");

  if (digest(source) !== inputSha256) throw new Error("Bob usage correction requires the exact permission-corrected entrypoint");
  let result = source.toString("utf8");

  for (const [original, replacement] of replacements) {
    if (result.split(original).length !== 2) throw new Error("Bob usage correction anchor is not unique");
    result = result.replace(original, replacement);
  }

  if (digest(result) !== outputSha256) throw new Error("Bob usage correction output checksum mismatch");

  return result;
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
