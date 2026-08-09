import type { ComponentProps } from "react";
import BossKeySettings from "./BossKeySettings";
import UpdateSettings from "./UpdateSettings";

interface Props {
  bossKey: ComponentProps<typeof BossKeySettings>;
  update: ComponentProps<typeof UpdateSettings>;
}

export default function SettingsAdvanced({ bossKey, update }: Props) {
  return (
    <>
      <BossKeySettings {...bossKey} />
      <UpdateSettings {...update} />
    </>
  );
}
