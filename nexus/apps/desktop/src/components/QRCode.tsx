import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Crisp SVG QR code (rendered locally; nothing is sent anywhere). */
export function QRCode({ value, size = 180 }: { value: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { path: d, n: count };
  }, [value]);
  const pad = 2;
  return (
    <svg width={size} height={size} viewBox={`${-pad} ${-pad} ${n + pad * 2} ${n + pad * 2}`} shapeRendering="crispEdges" className="rounded-2xl bg-[#eef1f5]" role="img" aria-label="Pairing QR code">
      <path d={path} fill="#101114" />
    </svg>
  );
}
