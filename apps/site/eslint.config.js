import { boundaries, react } from "@ofa/eslint-config";

// Same boundary as the web app: only browser-safe packages (R3).
export default [...react, ...boundaries.clientApp];
