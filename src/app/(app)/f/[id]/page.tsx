import { TeamView } from "./team-view";

interface TeamPageProps {
  params: Promise<{ id: string }>;
}

export default async function TeamPage({ params }: TeamPageProps) {
  const { id } = await params;
  return <TeamView teamId={id} />;
}
