import { ArrowRight } from "lucide-react";

export function instagramConnectionRoute(status: { instagram: {configured:boolean}; instagramFacebook: {configured:boolean} } | null): "instagram" | "instagramFacebook" | null {
  if (status?.instagram.configured) return "instagram";
  return status?.instagramFacebook.configured ? "instagramFacebook" : null;
}

export function ChannelConnectionButton({ ready, loading, canManage, label, onConnect }: { ready: boolean; loading: boolean; canManage: boolean; label: string; onConnect: () => void }) {
  if (!loading && !ready && canManage) return <a className="channel-connect-button" href="/setup">Set up connection <ArrowRight size={16} /></a>;
  return <button className="channel-connect-button" disabled={loading || !ready || !canManage} onClick={onConnect}>{!canManage ? "Owner access required" : label}<ArrowRight size={16} /></button>;
}

