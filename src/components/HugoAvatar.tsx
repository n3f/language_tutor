import { useEffect, useState, useMemo } from "react";
import hugoImg from "@/assets/hugo-avatar.png";

interface HugoAvatarProps {
  isSpeaking: boolean;
  size?: number;
  showBranding?: boolean;
}

export function HugoAvatar({ isSpeaking, size = 120, showBranding = false }: HugoAvatarProps) {
  const [eyeRoll, setEyeRoll] = useState(false);

  useEffect(() => {
    if (!isSpeaking) return;
    const interval = setInterval(
      () => {
        setEyeRoll(true);
        setTimeout(() => setEyeRoll(false), 800);
      },
      6000 + Math.random() * 4000,
    );
    return () => clearInterval(interval);
  }, [isSpeaking]);

  const curvedTopId = useMemo(() => `curved-top-${Math.random().toString(36).slice(2)}`, []);
  const curvedBottomId = useMemo(() => `curved-bottom-${Math.random().toString(36).slice(2)}`, []);

  const outerSize = showBranding ? size + 60 : size;
  const textRadius = size / 2 + 12;

  return (
    <div
      className="relative flex flex-col items-center"
      style={{ width: outerSize, height: outerSize }}
    >
      {/* Curved text SVG */}
      {showBranding && (
        <svg
          className="absolute inset-0 pointer-events-none"
          width={outerSize}
          height={outerSize}
          viewBox={`0 0 ${outerSize} ${outerSize}`}
        >
          <defs>
            <path
              id={curvedTopId}
              d={`M ${outerSize / 2 - textRadius}, ${outerSize / 2} A ${textRadius},${textRadius} 0 1,1 ${outerSize / 2 + textRadius},${outerSize / 2}`}
              fill="none"
            />
            <path
              id={curvedBottomId}
              d={`M ${outerSize / 2 + textRadius}, ${outerSize / 2} A ${textRadius},${textRadius} 0 1,1 ${outerSize / 2 - textRadius},${outerSize / 2}`}
              fill="none"
            />
          </defs>
          <text
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "14px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              fill: "var(--foreground)",
            }}
          >
            <textPath href={`#${curvedTopId}`} startOffset="50%" textAnchor="middle">
              CAUSONS!
            </textPath>
          </text>
          <text
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: "13px",
              fontWeight: 400,
              fontStyle: "italic",
              letterSpacing: "0.1em",
              fill: "var(--muted-foreground)",
            }}
          >
            <textPath href={`#${curvedBottomId}`} startOffset="50%" textAnchor="middle">
              Let's chat!
            </textPath>
          </text>
        </svg>
      )}

      {/* Hugo image - centered */}
      <div
        className="absolute overflow-hidden rounded-full"
        style={{
          width: size,
          height: size,
          top: (outerSize - size) / 2,
          left: (outerSize - size) / 2,
          border: "2px solid var(--border)",
        }}
      >
        <img
          src={hugoImg}
          alt="Victor Hugo AI Tutor"
          className={`h-full w-full object-cover scale-110 ${eyeRoll ? "animate-eye-roll" : ""}`}
        />
        {/* Mouth overlay */}
        {isSpeaking && (
          <div
            className="absolute bottom-[22%] left-1/2 -translate-x-1/2 rounded-full bg-foreground/80 animate-mouth"
            style={{ width: size * 0.15, height: size * 0.08 }}
          />
        )}
      </div>
      {/* Speaking indicator */}
      {isSpeaking && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex items-center gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="w-1 rounded-full bg-primary"
              style={{
                animation: `waveform 0.6s ease-in-out ${i * 0.1}s infinite`,
                height: 4,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
