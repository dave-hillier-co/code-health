package shop;

public class Report {
    @Override
    public String render(List<String> rows) throws IOException {
        StringBuilder out = new StringBuilder();
        rows.forEach(r -> {
            out.append(r);
        });
        for (String row : rows) {
            if (row.isEmpty() || row.startsWith("#")) {
                continue;
            }
            out.append("""
                while (true) {
                """);
        }
        char c = '"';
        return out.toString();
    }
}
