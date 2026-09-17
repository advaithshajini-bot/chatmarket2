// lib/domain/index.js
//
// Barrel export for the Chatmarket 2.0 domain layer. See
// docs/product-domain-model.md for the concepts this maps to (Product,
// Playbook, Workflow, Agent, Entitlement, Run, Tool, Permission,
// Approval, UsageEvent) and which phase wires up which write path.
//
// Every function here takes a Supabase client as its first argument and
// runs under RLS exactly as the rest of the app does -- there is no
// service-role/bypass client anywhere in this layer.

export * from "./products.js";
export * from "./productTools.js";
export * from "./productPermissions.js";
export * from "./entitlements.js";
export * from "./runs.js";
export * from "./usageEvents.js";
export * from "./approvals.js";
export * from "./payouts.js";
