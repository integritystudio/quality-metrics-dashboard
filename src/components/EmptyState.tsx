export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted text-center p-4">
      {message}
    </div>
  );
}
