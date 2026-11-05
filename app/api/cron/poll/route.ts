import { handleCronPoll } from "@/lib/cronPoll";

export async function GET(request: Request) {
  return handleCronPoll(request);
}
