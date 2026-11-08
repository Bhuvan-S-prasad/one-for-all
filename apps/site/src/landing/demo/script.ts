// The demo's conversations: one morning at Kestrel Coffee Roasters, a
// fictional three-person roastery (every name, address and figure here is
// invented). Each conversation is a list of beats played in order; a gate
// waits for the visitor (a button, or a suggested message).

export type Who = "chief" | "operator" | "inbox" | "researcher" | "writer";

/** What the Operator's computer shows, step by step. */
export type Screen = "login" | "typing" | "signed-in" | "catalog" | "order" | "review" | "placed";

export type Beat =
  | { readonly t: "user"; readonly text: string }
  | { readonly t: "agent"; readonly who: Who; readonly text: string }
  | { readonly t: "note"; readonly text: string }
  | { readonly t: "steps"; readonly who: Who; readonly items: readonly string[] }
  | { readonly t: "computer"; readonly ask: string }
  | {
      readonly t: "approval";
      readonly id: string;
      readonly who: Who;
      readonly title: string;
      readonly rows: readonly (readonly [string, string])[];
      /** A draft the visitor may edit before approving. */
      readonly draft?: string;
      readonly approved: string;
      readonly denied: string;
    }
  | {
      readonly t: "plan";
      readonly items: readonly (readonly [Who | "me", string])[];
    }
  | { readonly t: "handoff"; readonly to: Who; readonly text: string }
  | {
      readonly t: "table";
      readonly who: Who;
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly sources: readonly string[];
    }
  | { readonly t: "screen"; readonly screen: Screen }
  | {
      readonly t: "gate";
      /** `takeover` and `done` are the computer card's buttons; `approve:<id>` the card's. */
      readonly until: "takeover" | "done" | `approve:${string}` | "chip";
      /** Suggested messages for `chip`: pressing one sends it and plays on. */
      readonly chips?: readonly string[];
    };

export interface Conversation {
  readonly id: string;
  readonly kind: "direct" | "group";
  readonly who: readonly Who[];
  readonly name: string;
  readonly time: string;
  /** The row's preview before the visitor opens it. */
  readonly preview: string;
  readonly state?: "needs" | "unread" | "working";
  readonly unread?: number;
  readonly beats: readonly Beat[];
}

export const NAMES: Record<Who, string> = {
  chief: "Chief of staff",
  operator: "Operator",
  inbox: "Gmail agent",
  researcher: "Researcher",
  writer: "Writer",
};

export const OPERATOR: Conversation = {
  id: "operator",
  kind: "direct",
  who: ["operator"],
  name: "Operator",
  time: "8:29",
  preview: "Sign in to Green Field so I can see your account.",
  state: "needs",
  beats: [
    {
      t: "user",
      text: "Reorder 3 sacks of the Huila decaf from Green Field at last month's price. Stop before paying.",
    },
    { t: "agent", who: "operator", text: "On it. Opening the Green Field portal on my computer." },
    { t: "screen", screen: "login" },
    {
      t: "steps",
      who: "operator",
      items: ["Opened portal.greenfield.example", "Found your saved login: none"],
    },
    {
      t: "computer",
      ask: "Sign in to Green Field so I can see your account. I never see the password.",
    },
    { t: "gate", until: "takeover" },
    { t: "screen", screen: "typing" },
    { t: "gate", until: "done" },
    { t: "screen", screen: "signed-in" },
    { t: "agent", who: "operator", text: "Thanks, I'm in. Finding last month's order." },
    { t: "screen", screen: "catalog" },
    {
      t: "steps",
      who: "operator",
      items: [
        "Read order history · invoice GF-20514, 14 Oct",
        "Huila Decaf, 60 kg sack · $6.87/kg then, $6.87/kg now",
        "Typed 3 into Quantity",
      ],
    },
    { t: "screen", screen: "order" },
    { t: "screen", screen: "review" },
    {
      t: "agent",
      who: "operator",
      text: "The order is ready and **not placed**. Same price as October, delivery Thursday 14 Nov.",
    },
    {
      t: "approval",
      id: "order",
      who: "operator",
      title: "Place the order with Green Field?",
      rows: [
        ["Items", "3 × Huila Decaf, 60 kg"],
        ["Price", "$6.87/kg · same as invoice GF-20514"],
        ["Total", "$1,236.60 + $48 freight"],
        ["Pays with", "account terms, net 30"],
      ],
      approved:
        "Placed. Confirmation GF-20931 is in your files, and I added the delivery to the calendar.",
      denied: "Left it in the cart. Nothing was ordered.",
    },
    { t: "gate", until: "approve:order" },
    { t: "screen", screen: "placed" },
  ],
};

export const INBOX: Conversation = {
  id: "inbox",
  kind: "direct",
  who: ["inbox"],
  name: "Gmail agent",
  time: "7:31",
  preview: "4 new emails. One wants a reply from you.",
  state: "unread",
  unread: 2,
  beats: [
    { t: "note", text: "Morning inbox sweep · routine · 07:30" },
    {
      t: "agent",
      who: "inbox",
      text: "4 new emails since yesterday. Two orders (filed), one newsletter (skipped), and **Café Lumen** wants 10 kg of the house espresso every two weeks.",
    },
    {
      t: "steps",
      who: "inbox",
      items: [
        "Searched new mail · 4 messages",
        "Read 4 messages",
        "Checked the wholesale price list",
      ],
    },
    {
      t: "approval",
      id: "reply",
      who: "inbox",
      title: "Send this reply to Café Lumen?",
      rows: [
        ["To", "orders@cafelumen.example"],
        ["Subject", "Re: Fortnightly espresso"],
      ],
      draft:
        "Hi Jonah, happy to set that up. 10 kg of Kestrel House every other Monday at the wholesale rate ($19.40/kg), first delivery on the 18th. I'll send the standing order form today. Maya",
      approved: "Sent. I'll file their reply when it comes in.",
      denied: "Kept it as a draft in Gmail.",
    },
    { t: "gate", until: "approve:reply" },
  ],
};

export const OPS: Conversation = {
  id: "ops",
  kind: "group",
  who: ["chief", "researcher", "writer"],
  name: "Kestrel ops",
  time: "Yesterday",
  preview: "Writer: Draft of the spring price list is ready.",
  beats: [
    {
      t: "gate",
      until: "chip",
      chips: ["@all what should change in the wholesale price list for spring?"],
    },
    { t: "agent", who: "chief", text: "Good question for the whole team. Here's the plan." },
    {
      t: "plan",
      items: [
        ["researcher", "check green coffee prices since autumn"],
        ["writer", "draft the spring list and a note for cafés"],
        ["me", "put it together for Maya"],
      ],
    },
    {
      t: "handoff",
      to: "researcher",
      text: "Asked Researcher: green coffee prices since September",
    },
    {
      t: "agent",
      who: "researcher",
      text: "Arabica futures are up about 9% since September; Colombian washed lots most. Our Huila supply is on a fixed contract until March, so only the Kenyan and Ethiopian lots move.",
    },
    { t: "handoff", to: "writer", text: "Asked Writer: draft the spring list" },
    {
      t: "agent",
      who: "writer",
      text: "Draft is ready: Kenya AA and Yirgacheffe up $1.10/kg, everything else unchanged, and a two-line note for cafés explaining why.",
    },
    {
      t: "agent",
      who: "chief",
      text: "**Agreed:** raise only the two African lots by $1.10/kg from 1 March, keep the house blends where they are, and send cafés the Writer's note a month ahead. The draft is in Files.",
    },
  ],
};

export const RESEARCH: Conversation = {
  id: "researcher",
  kind: "direct",
  who: ["researcher"],
  name: "Researcher",
  time: "Mon",
  preview: "Compared three roasters' subscription prices.",
  beats: [
    {
      t: "gate",
      until: "chip",
      chips: ["Compare our subscription with three other small roasters"],
    },
    {
      t: "steps",
      who: "researcher",
      items: ["Searched the web · 6 queries", "Read 9 pages", "Built a table"],
    },
    {
      t: "table",
      who: "researcher",
      head: ["Roaster", "250 g / month", "Shipping", "Pause anytime"],
      rows: [
        ["Kestrel", "$14.50", "Free", "Yes"],
        ["Roaster A", "$16.00", "$4.95", "Yes"],
        ["Roaster B", "$13.75", "Free over 2 bags", "No"],
        ["Roaster C", "$15.20", "Free", "Yes"],
      ],
      sources: ["roaster-a.example/subscribe", "roaster-b.example/plans", "roaster-c.example/faq"],
    },
    {
      t: "agent",
      who: "researcher",
      text: "We're second cheapest and the only one with free shipping on a single bag. Worth saying on the subscribe page.",
    },
  ],
};

export const CHIEF_DM: Conversation = {
  id: "chief",
  kind: "direct",
  who: ["chief"],
  name: "Chief of staff",
  time: "7:45",
  preview: "Morning. 6 web orders overnight, $418.",
  beats: [
    { t: "note", text: "Morning brief · routine · 07:45" },
    {
      t: "agent",
      who: "chief",
      text: "Morning, Maya. Overnight: **6 web orders ($418)**, all paid and labelled. Café Lumen wants a standing order; the reply is drafted for you. Operator is waiting on a Green Field sign-in for the decaf reorder.",
    },
    { t: "gate", until: "chip", chips: ["What's left for today?"] },
    {
      t: "plan",
      items: [
        ["inbox", "send the Café Lumen reply (needs you)"],
        ["operator", "reorder the Huila decaf (needs you)"],
        ["writer", "Friday newsletter draft by 3 pm"],
      ],
    },
  ],
};

export const CONVERSATIONS: readonly Conversation[] = [OPERATOR, INBOX, CHIEF_DM, OPS, RESEARCH];
