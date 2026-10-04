import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { isRecord } from "../utils/type-guards.js";
import { BobError } from "./errors.js";
import type { BobApprovalPolicy } from "./types.js";

const kinds = ["edit", "delete", "execute", "search", "fetch"] as const;

/** Validate and copy so callers cannot mutate an installed policy. */
export function copyApprovalPolicy(policy: BobApprovalPolicy | undefined): BobApprovalPolicy | undefined {
  if (policy === undefined) return undefined;

  try {
    if (!isRecord(policy)) throw new Error();
    // Read accessor-backed input once, then validate exactly what will be installed.
    const snapshot = { ...policy };

    if (Object.keys(snapshot).some((key) => key !== "kinds" && key !== "fallback")
      || (snapshot.fallback !== undefined && snapshot.fallback !== "ask" && snapshot.fallback !== "deny")
      || (snapshot.kinds !== undefined && !isRecord(snapshot.kinds))) throw new Error();
    const rules = { ...snapshot.kinds };

    if (Object.entries(rules).some(([kind, decision]) =>
      !kinds.some((category) => category === kind) || (decision !== "allow" && decision !== "deny" && decision !== "ask"))) throw new Error();

    return { fallback: snapshot.fallback, kinds: rules };
  } catch {
    throw new BobError("configuration_invalid");
  }
}

/** Undefined means manual. Ambiguous/missing one-time options also remain manual. */
export function approvalDecision(policy: BobApprovalPolicy | undefined, request: RequestPermissionRequest) {
  if (!policy) return undefined;
  const kind = request.toolCall.kind;
  const category = kinds.find((category) => category === kind);
  const rule = category === undefined ? undefined : policy.kinds?.[category];
  const decision = rule ?? policy.fallback;

  if (decision !== "allow" && decision !== "deny") return undefined;
  const options = request.options.filter((option) => option.kind === (decision === "allow" ? "allow_once" : "reject_once"));

  if (options.length !== 1 || request.options.filter((option) => option.optionId === options[0].optionId).length !== 1) return undefined;

  const attribution = category !== undefined && rule !== undefined
    ? { match: "category" as const, kind: category, decision }
    : { match: "fallback" as const, kind: kind ?? null, decision: "deny" as const };

  return { optionId: options[0].optionId, attribution };
}
