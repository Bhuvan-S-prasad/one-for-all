import { page, type WebFixture } from "./web";

// Larkspur is made up, so no model can answer from memory: the facts exist
// only in these pages. The forum thread is a decoy with the wrong date.

export const LARKSPUR_NOTES = "https://larkspur.example.org/blog/larkspur-3-0";
export const LARKSPUR_FORUM = "https://forum.example.net/t/larkspur-3-rumours";

export const larkspurWeb: WebFixture = {
  searches: [
    {
      match: ["larkspur"],
      results: [
        {
          title: "Larkspur 3.0 rumours and wishlist",
          url: LARKSPUR_FORUM,
          snippet: "Community thread: what we expect from the next Larkspur release.",
        },
        {
          title: "Announcing Larkspur 3.0 · Larkspur blog",
          url: LARKSPUR_NOTES,
          snippet: "Release notes for Larkspur 3.0, the Postgres connection pooler.",
        },
        {
          title: "larkspur/larkspur: a small Postgres connection pooler",
          url: "https://code.example.com/larkspur/larkspur",
          snippet: "Source code, issues and install instructions.",
        },
      ],
    },
  ],
  pages: {
    [LARKSPUR_NOTES]: page(
      "Announcing Larkspur 3.0",
      "Larkspur 3.0 was released on 14 August 2026.",
      "The headline feature is intent routing: Larkspur now sends read-only transactions to replicas and everything else to the primary, without changes to your application.",
      "This release also drops support for Postgres 13.",
    ),
    [LARKSPUR_FORUM]: page(
      "Larkspur 3.0 rumours and wishlist",
      "I heard 3.0 ships in March 2026 with built-in sharding. Can't wait!",
      "Not confirmed by the maintainers, just what someone said at a meetup.",
    ),
  },
};
