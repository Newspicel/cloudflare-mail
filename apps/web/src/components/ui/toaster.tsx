import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/lib/theme";

export function Toaster() {
  const { theme } = useTheme();
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      gap={8}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-lg !shadow-black/10 !text-[13px]",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md",
          cancelButton: "!bg-muted !text-muted-foreground !rounded-md",
          error: "!text-destructive",
          success: "!text-success",
        },
      }}
    />
  );
}
