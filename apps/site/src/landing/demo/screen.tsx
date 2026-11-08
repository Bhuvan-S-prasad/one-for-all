import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Screen } from "./script";

/** The width the supplier's page is laid out at, before scaling. */
const SCREEN_W = 540;

// The Operator's computer as the visitor watches it: a browser on a
// fictional supplier's portal (portal.greenfield.example). Each step of the
// script shows the page the agent is on, with its pointer where it works.

const URLS: Record<Screen, string> = {
  login: "portal.greenfield.example/sign-in",
  typing: "portal.greenfield.example/sign-in",
  "signed-in": "portal.greenfield.example/account",
  catalog: "portal.greenfield.example/orders",
  order: "portal.greenfield.example/order/new",
  review: "portal.greenfield.example/order/review",
  placed: "portal.greenfield.example/order/GF-20931",
};

/** "maya@kestrel.example" appearing a letter at a time while the visitor is in control. */
function useTyped(text: string, on: boolean, delay = 55): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    // Counts only while on, so it starts from the first letter.
    if (!on) return;
    const id = setInterval(() => setN((i) => (i >= text.length ? i : i + 1)), delay);
    return () => clearInterval(id);
  }, [on, text, delay]);
  return on ? text.slice(0, n) : "";
}

function Field({ label, value, focus }: { label: string; value: ReactNode; focus?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-[#5d6b5f]">{label}</span>
      <span
        className={`flex h-7 items-center rounded-[6px] border bg-white px-2 text-[11px] text-[#1d2a20] ${
          focus ? "border-[#2f7a4a] ring-2 ring-[#2f7a4a]/25" : "border-[#cfd8cf]"
        }`}
      >
        {value}
      </span>
    </label>
  );
}

/** The agent's pointer, labelled, where it is working. */
function AgentPointer({ x, y }: { x: string; y: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-10 transition-[left,top] duration-700 ease-[cubic-bezier(.2,.8,.2,1)]"
      style={{ left: x, top: y }}
    >
      <svg width="14" height="18" viewBox="0 0 14 18">
        <path
          d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z"
          fill="#ff6a3d"
          stroke="#fff"
          strokeWidth="1.2"
        />
      </svg>
      <span className="ml-3 rounded-[5px] bg-[#ff6a3d] px-1.5 py-px text-[9px] font-semibold text-white">
        Operator
      </span>
    </span>
  );
}

const POINTER: Partial<Record<Screen, [string, string]>> = {
  login: ["62%", "71%"],
  "signed-in": ["30%", "38%"],
  catalog: ["70%", "47%"],
  order: ["66%", "57%"],
  review: ["86%", "66%"],
};

export function SupplierScreen({ screen, className = "" }: { screen: Screen; className?: string }) {
  const typing = screen === "typing";
  const email = useTyped("maya@kestrel.example", typing);
  const dots = useTyped("••••••••••••", typing && email.length >= 20, 70);
  const pointer = POINTER[screen];
  // The page is laid out at one size, like a real screen, and scaled to fit
  // wherever it is shown (the chat card or the narrower side panel).
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / SCREEN_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      className={`relative aspect-[16/10] w-full overflow-hidden rounded-[12px] bg-[#f5f3ec] ${className}`}
    >
      <div
        className="absolute top-0 left-0 flex origin-top-left flex-col text-left"
        style={{ width: SCREEN_W, height: SCREEN_W / 1.6, transform: `scale(${scale})` }}
      >
        {/* The browser's own bar */}
        <div className="flex h-7 shrink-0 items-center gap-2 bg-[#e6e3da] px-2.5">
          <span className="flex gap-1" aria-hidden>
            <span className="size-[7px] rounded-full bg-[#c9c5ba]" />
            <span className="size-[7px] rounded-full bg-[#c9c5ba]" />
            <span className="size-[7px] rounded-full bg-[#c9c5ba]" />
          </span>
          <span className="flex h-[18px] min-w-0 flex-1 items-center gap-1 truncate rounded-full bg-white/80 px-2.5 font-mono text-[9.5px] text-[#4d564f]">
            <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden>
              <rect x="1" y="4" width="6" height="5" rx="1" fill="#4d564f" />
              <path d="M2.2 4V2.8a1.8 1.8 0 0 1 3.6 0V4" fill="none" stroke="#4d564f" />
            </svg>
            {URLS[screen]}
          </span>
        </div>
        {typing && (
          <div className="flex h-6 shrink-0 items-center justify-center gap-1.5 bg-primary text-[10px] font-semibold text-primary-foreground">
            You're in control · the Operator can't see what you type
          </div>
        )}

        {/* The supplier's page */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#dfdbd0] bg-white px-4 py-2">
          <span className="flex items-center gap-1.5 text-[12px] font-bold text-[#1f4d2f]">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M7 1C3 4 3 9 7 13C11 9 11 4 7 1Z" fill="#2f7a4a" />
              <path d="M7 3V12" stroke="#fff" strokeWidth="1" />
            </svg>
            Green Field Imports
          </span>
          <span className="text-[9.5px] text-[#5d6b5f]">
            {screen === "login" || screen === "typing"
              ? "Wholesale green coffee"
              : "Kestrel Coffee Roasters ▾"}
          </span>
        </div>

        <div className="relative min-h-0 flex-1 px-5 py-4 text-[#1d2a20]">
          {(screen === "login" || screen === "typing") && (
            <div className="mx-auto flex max-w-[230px] flex-col gap-2.5 rounded-[10px] bg-white p-4 shadow-sm">
              <span className="text-[13px] font-bold">Sign in to your account</span>
              <Field
                label="Email"
                focus={typing && email.length < 20}
                value={
                  <>
                    {email}
                    {typing && email.length < 20 && <span className="caret">|</span>}
                  </>
                }
              />
              <Field label="Password" focus={typing && email.length >= 20} value={dots} />
              <span
                className={`mt-1 flex h-7 items-center justify-center rounded-[6px] text-[11px] font-semibold text-white ${
                  dots.length >= 12 ? "bg-[#2f7a4a]" : "bg-[#2f7a4a]/60"
                }`}
              >
                Sign in
              </span>
            </div>
          )}

          {screen === "signed-in" && (
            <div className="flex flex-col gap-3">
              <span className="text-[14px] font-bold">Welcome back, Kestrel Coffee</span>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                {[
                  ["Orders", "Order history"],
                  ["Catalogue", "62 lots in stock"],
                  ["Account", "Net 30 terms"],
                ].map(([a, b]) => (
                  <span key={a} className="flex flex-col rounded-[8px] bg-white p-2.5 shadow-sm">
                    <span className="font-semibold">{a}</span>
                    <span className="text-[#5d6b5f]">{b}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {screen === "catalog" && (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-bold">Order history</span>
              <div className="overflow-hidden rounded-[8px] bg-white text-[10px] shadow-sm">
                {[
                  ["GF-20514", "14 Oct", "Huila Decaf, 60 kg × 3", "$1,236.60", true],
                  ["GF-20377", "16 Sep", "Kenya AA, 60 kg × 2", "$1,104.00", false],
                  ["GF-20202", "12 Aug", "Huila Decaf, 60 kg × 2", "$824.40", false],
                ].map(([id, date, what, total, hot]) => (
                  <div
                    key={id as string}
                    className={`grid grid-cols-[60px_44px_1fr_64px] gap-2 border-b border-[#eee] px-2.5 py-1.5 last:border-0 ${
                      hot ? "bg-[#fff5d6]" : ""
                    }`}
                  >
                    <span className="font-mono">{id}</span>
                    <span className="text-[#5d6b5f]">{date}</span>
                    <span>{what}</span>
                    <span className="text-right">{total}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {screen === "order" && (
            <div className="flex flex-col gap-2.5">
              <span className="text-[13px] font-bold">New order</span>
              <div className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-[8px] bg-white p-3 text-[10.5px] shadow-sm">
                <span className="flex flex-col">
                  <span className="font-semibold">Huila Decaf · Colombia · Swiss Water</span>
                  <span className="text-[#5d6b5f]">60 kg jute sack · $6.87/kg · 41 sacks left</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[#5d6b5f]">Qty</span>
                  <span className="flex h-7 w-10 items-center justify-center rounded-[6px] border border-[#2f7a4a] font-semibold ring-2 ring-[#2f7a4a]/25">
                    3
                  </span>
                </span>
              </div>
              <span className="self-end rounded-[6px] bg-[#2f7a4a] px-3 py-1.5 text-[10.5px] font-semibold text-white">
                Review order →
              </span>
            </div>
          )}

          {(screen === "review" || screen === "placed") && (
            <div className="flex flex-col gap-2.5">
              <span className="flex items-center gap-2 text-[13px] font-bold">
                {screen === "placed" ? "Order placed · GF-20931" : "Review your order"}
                {screen === "placed" && (
                  <span className="rounded-full bg-[#2f7a4a] px-2 py-px text-[9px] text-white">
                    Confirmed
                  </span>
                )}
              </span>
              <dl className="grid grid-cols-[90px_1fr] gap-y-1 rounded-[8px] bg-white p-3 text-[10.5px] shadow-sm">
                <dt className="text-[#5d6b5f]">Items</dt>
                <dd>3 × Huila Decaf, 60 kg</dd>
                <dt className="text-[#5d6b5f]">Subtotal</dt>
                <dd>$1,236.60</dd>
                <dt className="text-[#5d6b5f]">Freight</dt>
                <dd>$48.00 · arrives Thu 14 Nov</dd>
                <dt className="text-[#5d6b5f]">Payment</dt>
                <dd>Account terms, net 30</dd>
              </dl>
              {screen === "review" && (
                <span className="flex items-center justify-end gap-2">
                  <span className="rounded-full bg-[#fff5d6] px-2 py-0.5 text-[9.5px] text-[#7a5a00]">
                    Waiting for Maya's OK
                  </span>
                  <span className="rounded-[6px] bg-[#2f7a4a]/60 px-3 py-1.5 text-[10.5px] font-semibold text-white">
                    Place order
                  </span>
                </span>
              )}
            </div>
          )}

          {pointer && <AgentPointer x={pointer[0]} y={pointer[1]} />}
        </div>
      </div>
    </div>
  );
}
