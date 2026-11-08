import { boundaries, react } from "@ofa/eslint-config";

// The web app's boundary (R3). The index script under scripts/ reads the
// repository as text with the TypeScript compiler and imports none of it
// (ADR-0051).
export default [...react, ...boundaries.clientApp];
