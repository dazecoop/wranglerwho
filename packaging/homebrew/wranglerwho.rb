# Canonical source for the Homebrew formula.
# It is published to the tap repo (dazecoop/homebrew-tap) as Formula/wranglerwho.rb.
# The url + sha256 point at the npm tarball, so this activates once `npm publish` runs.
# If you change the package before publishing, refresh sha256 with:
#   npm pack && shasum -a 256 wranglerwho-*.tgz
class Wranglerwho < Formula
  desc "Switch between multiple Cloudflare / wrangler accounts"
  homepage "https://github.com/dazecoop/wranglerwho"
  url "https://registry.npmjs.org/wranglerwho/-/wranglerwho-0.1.0.tgz"
  sha256 "ade3d2390961b621d417436ce08bafe9554eabf3f2e21e10d7bc2e43e5a1422e"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "wranglerwho", shell_output("#{bin}/wranglerwho help")
  end
end
