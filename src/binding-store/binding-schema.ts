import path from "node:path";
import { z } from "zod";

export const repositoryCwdSchema = z
  .string()
  .min(1, "repository binding cwd must not be empty")
  .refine(path.isAbsolute, "repository binding cwd must be an absolute path");

export const topicRepositoryBindingSchema = z.object({
  cwd: repositoryCwdSchema,
});

export const storedBindingSchema = z
  .object({
    cwd: repositoryCwdSchema.optional(),
    topics: z.record(z.string(), topicRepositoryBindingSchema).optional(),
  })
  .refine(
    (binding) =>
      (binding.cwd !== undefined || binding.topics !== undefined) &&
      (binding.topics === undefined || Object.keys(binding.topics).length > 0),
    "a binding must contain a cwd or at least one topic",
  );

export type StoredBinding = z.infer<typeof storedBindingSchema>;
