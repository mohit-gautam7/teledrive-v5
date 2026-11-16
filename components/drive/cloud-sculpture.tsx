import { FileText, Image, Music2, ShieldCheck } from "lucide-react";

/** Decorative CSS geometry: no WebGL context, external assets, or render loop. */
export function CloudSculpture() {
  return <div className="cloud-sculpture" aria-hidden="true">
    <div className="cloud-orbit" />
    <div className="cloud-stack">
      <div className="cloud-sheet cloud-sheet-back"><Music2 /><span /><span /></div>
      <div className="cloud-sheet cloud-sheet-middle"><FileText /><span /><span /></div>
      <div className="cloud-sheet cloud-sheet-front"><Image /><div className="cloud-landscape" /><span /></div>
    </div>
    <div className="cloud-seal"><ShieldCheck size={18} /></div>
  </div>;
}
