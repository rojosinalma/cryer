import pkg from "../package.json" with { type: "json" };

export const version: string = process.env.CRYER_VERSION || pkg.version;
