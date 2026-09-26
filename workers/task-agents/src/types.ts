export const SPECIALIST_ROLES = ["research", "strategy", "verification"] as const;

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export interface TaskEnvelope {
  runId: string;
  orgId: string;
  userId: string;
  taskType: string;
  phase: string;
  inputRefs: string[];
  outputSchemaId: string;
  task?: string;
}

export interface ToolGrant {
  name: string;
  orgIds: string[];
  userIds: string[];
  tasks: string[];
  roles: SpecialistRole[];
}

export interface ResolvedToolkit {
  orgId: string;
  userId: string;
  taskType: string;
  role: SpecialistRole;
  tools: string[];
}

export interface TraceEvent {
  at: string;
  step: string;
  detail: string;
}

export interface LocalCompany {
  name: string;
  address: string;
  website: string;
  phone: string;
  mapsUrl: string;
}

export interface RunSource {
  url: string;
  title: string;
}

export interface OperatingTask {
  id: number;
  title: string;
  status: "pending" | "active" | "completed" | "blocked";
}

export interface OperatingPlan {
  runId: string;
  summary: string;
  tasks: OperatingTask[];
}

export interface TaskAgentState {
  envelope: TaskEnvelope | null;
  role: SpecialistRole | null;
  tools: string[];
  events: TraceEvent[];
  places: LocalCompany[];
  sources: RunSource[];
  toolGroups: string[];
  catalogStage: "global" | "local" | "action";
  selectedGlobals: string[];
  workflowId: string;
  companyContextLoaded?: boolean;
  companyContextRequired?: boolean;
  profileBrief?: string;
  awaiting: "" | "input" | "memory";
  operatingPlan?: OperatingPlan | null;
}
