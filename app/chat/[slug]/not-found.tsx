import { MessageSquareOff } from "lucide-react";

export default function ChatNotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <MessageSquareOff className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h1 className="text-xl font-bold text-gray-800 mb-2">Чат недоступен</h1>
        <p className="text-sm text-gray-500">
          Этот чат поддержки не найден или временно отключён.
        </p>
      </div>
    </div>
  );
}
