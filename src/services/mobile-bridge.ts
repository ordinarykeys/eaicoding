import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "@/types/llm";

export interface MobileBridgeInfo {
  running: boolean;
  url: string | null;
  localUrl: string | null;
  lanIp: string | null;
  port: number | null;
  startedAt: number | null;
}

export interface MobileAction {
  id: string;
  type: "send_message" | "set_active_session" | "new_session" | "quick_action" | string;
  content?: string | null;
  sessionId?: string | null;
  prompt?: string | null;
  createdAt: number;
}

export interface MobileSnapshotSession {
  id: string;
  title: string;
  updatedAt: number;
  lastMessagePreview: string;
}

export interface MobileSnapshotPreview {
  id: string;
  title: string;
  code: string;
  html?: string;
  sourceLabel: string;
  stepIndex: number;
}

export interface MobileSnapshotStep {
  index: number;
  label: string;
  detail: string;
}

export interface MobileSnapshotMessage
  extends Pick<ChatMessage, "id" | "role" | "content" | "timestamp" | "isStreaming"> {
  html?: string;
}

export interface MobileSnapshot {
  activeSessionId: string | null;
  sessions: MobileSnapshotSession[];
  messages: MobileSnapshotMessage[];
  previewItems: MobileSnapshotPreview[];
  steps: MobileSnapshotStep[];
  statusLine: string | null;
  isStreaming: boolean;
  updatedAt: number;
}

export function startMobileBridge(): Promise<MobileBridgeInfo> {
  return invoke<MobileBridgeInfo>("start_mobile_bridge");
}

export function stopMobileBridge(): Promise<MobileBridgeInfo> {
  return invoke<MobileBridgeInfo>("stop_mobile_bridge");
}

export function getMobileBridgeState(): Promise<MobileBridgeInfo> {
  return invoke<MobileBridgeInfo>("get_mobile_bridge_state");
}

export function pollMobileActions(): Promise<MobileAction[]> {
  return invoke<MobileAction[]>("poll_mobile_actions");
}

export function publishMobileSnapshot(snapshot: MobileSnapshot): Promise<void> {
  return invoke<void>("publish_mobile_snapshot", { snapshot });
}
