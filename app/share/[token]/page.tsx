import ShareViewer from "@/components/share-viewer";

export default async function SharePage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  return <ShareViewer token={params.token} />;
}
