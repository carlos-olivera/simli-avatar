import SimliOpenAI from "./SimliOpenAI";

// Read at request time so LOGO_URL can be changed in Railway without a rebuild.
export const dynamic = "force-dynamic";

export default function Page() {
  const logoUrl = process.env.LOGO_URL || process.env.NEXT_PUBLIC_LOGO_URL || "";

  return (
    <main className="relative min-h-screen w-full bg-black flex items-center justify-center font-abc-repro text-white">
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt="Logo"
          className="absolute top-6 left-6 max-h-16 max-w-[40vw] object-contain pointer-events-none select-none z-10"
        />
      )}
      <SimliOpenAI />
    </main>
  );
}
