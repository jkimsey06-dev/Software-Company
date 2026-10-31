import { z } from "zod";

export interface OwnerAdmin {
  // The business's name, or null if there is no such business.
  tenantName(tenantId: string): Promise<string | null>;
  findUserId(email: string): Promise<string | null>;
  // Creates a confirmed user. Sends no email.
  createUser(email: string): Promise<string>;
  addMember(tenantId: string, userId: string, role: "owner" | "staff"): Promise<"added" | "exists">;
}

const argsSchema = z.object({
  tenantId: z.uuid(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: z.enum(["owner", "staff"]),
});

export type AddOwnerArgs = z.infer<typeof argsSchema> & { apply: boolean };

// `add-owner <tenant-id> <email> [owner|staff] [--apply]`
export function parseAddOwnerArgs(argv: string[]): AddOwnerArgs | null {
  const apply = argv.includes("--apply");
  const rest = argv.filter((a) => a !== "--apply");
  const parsed = argsSchema.safeParse({ tenantId: rest[0], email: rest[1], role: rest[2] ?? "owner" });
  if (!parsed.success || rest.length > 3) return null;
  return { ...parsed.data, apply };
}

export interface AddOwnerResult {
  tenantName: string;
  userExists: boolean;
  alreadyMember: boolean;
  applied: boolean;
}

// Without `apply` this only looks, so the operator sees what would change
// (and which business it is) before anything is written.
export async function addOwner(admin: OwnerAdmin, args: AddOwnerArgs): Promise<AddOwnerResult> {
  const tenantName = await admin.tenantName(args.tenantId);
  if (!tenantName) throw new Error("No business with that tenant id.");
  const existing = await admin.findUserId(args.email);
  if (!args.apply) return { tenantName, userExists: existing !== null, alreadyMember: false, applied: false };
  const userId = existing ?? (await admin.createUser(args.email));
  const added = await admin.addMember(args.tenantId, userId, args.role);
  return { tenantName, userExists: existing !== null, alreadyMember: added === "exists", applied: true };
}
