import type { ComponentProps } from "react";

/** Keeps the platform menu and keyboard controls, with a consistent field surface. */
export function NativeSelect({ className = "", children, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block w-full">
      <select {...props} className={`native-select ${className}`}>{children}</select>
    </span>
  );
}
