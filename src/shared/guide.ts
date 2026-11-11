// The "Get started" checklist: five steps, each ticked from what the owner has really done.
// Plain data in and out, so it can be tested without a browser.

export interface GuideInput {
  requests: Array<{ ran: boolean; hasOrder: boolean }>;
  /** Pages the owner has opened, remembered in their browser. */
  visited: { town: boolean; playground: boolean; orders: boolean };
  hasCase: boolean;
}

export type GuideAction = { label: string; href: string } | { label: string; run: "new" };

export interface GuideStep {
  id: "request" | "run" | "watch" | "decide" | "orders";
  title: string;
  text: string;
  done: boolean;
  action: GuideAction;
}

export interface Guide {
  steps: GuideStep[];
  doneCount: number;
  /** Index of the first step not done yet, or the number of steps when everything is done. */
  current: number;
}

export function guideSteps(input: GuideInput): Guide {
  const steps: GuideStep[] = [
    {
      id: "request",
      title: "Tell it what to buy",
      text: "A specific item, or a gift for someone. You set the most you will pay.",
      done: input.requests.length > 0,
      action: { label: "New request", run: "new" },
    },
    {
      id: "run",
      title: "Your shopper looks",
      text: "It visits three shops, checks each seller, and steers clear of the scam shop.",
      done: input.requests.some((r) => r.ran),
      action: { label: "Run it in the Playground", href: "#/playground" },
    },
    {
      id: "watch",
      title: "Watch the Town",
      text: "See your shopper walk between the shops, the guard and PayPal. Your agent has a ring around it.",
      done: input.visited.town || input.visited.playground,
      action: { label: "Open the Town", href: "#/town" },
    },
    {
      id: "decide",
      title: "You decide",
      text: "Rules decide what is allowed. When your shopper needs you, a bar at the top says so. A gift always asks, and so does anything above your limit.",
      done: input.requests.some((r) => r.hasOrder),
      action: { label: "See my requests", href: "#/" },
    },
    {
      id: "orders",
      title: "Check your orders",
      text: "If a price drops or the wrong item arrives, your shopper builds the case and you press one button for the refund.",
      done: input.visited.orders || input.hasCase,
      action: { label: "Open Orders", href: "#/orders" },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const first = steps.findIndex((s) => !s.done);
  return { steps, doneCount, current: first === -1 ? steps.length : first };
}
