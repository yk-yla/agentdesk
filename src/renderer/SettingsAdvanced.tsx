import type { ComponentProps } from "react";
import UpdateSettings from "./UpdateSettings";

interface Props {
  update: ComponentProps<typeof UpdateSettings>;
}

export default function SettingsAdvanced({ update }: Props) {
  return (
    <>
      <UpdateSettings {...update} />
    </>
  );
}
