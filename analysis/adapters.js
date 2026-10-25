// Generated-code adapters, shared by the diff export (which files are generated) and the
// analysis (where a usage of generated code leads). Each one switches on by what the
// repository contains; .review.yaml can override that.
export const ADAPTERS = {
  // Serverpod: a generated class maps to its model class (minus the suffix), a field to the
  // model field of the same name, and a relation's …Id column to the relation.
  serverpod: {
    detect: /\.spy(\.ya?ml)?$/, generated: ['**/generated/**', '**/migrations/**'],
    model: { kind: 'yaml', generated: ['**/generated/**'], source: ['**/*.spy.yaml', '**/*.spy.yml', '**/*.spy'], classSuffixes: 'Table|Include|IncludeList|Repository|AttachRepository|AttachRowRepository|DetachRepository|DetachRowRepository' },
  },
  // Generated part files (build_runner: freezed, json_serializable, built_value, riverpod...):
  // a generated declaration maps to the one it was generated for, in the library that owns
  // the part. _$User, $UserCopyWith and _User map to User, and their members to User's.
  build_runner: {
    detect: /\.(g|freezed)\.dart$/, generated: ['**/*.g.dart', '**/*.freezed.dart', '**/*.gr.dart', '**/*.config.dart', '**/*.mocks.dart'],
    model: { kind: 'part', generated: ['**/*.g.dart', '**/*.freezed.dart'] },
  },
  // Protobuf: a generated message class maps to its .proto message, and a getter (or its
  // has/clear/ensure accessor) to the field of the same name in snake_case.
  protobuf: {
    detect: /\.proto$/, generated: ['**/*.pb.dart', '**/*.pbenum.dart', '**/*.pbjson.dart', '**/*.pbserver.dart', '**/*.pbgrpc.dart'],
    model: { kind: 'proto', generated: ['**/*.pb.dart'], source: '**/*.proto' },
  },
};

// Files set aside as generated whatever adapters are on, each with what writes it: pub get writes
// a pubspec.lock, and the Dependencies view says what it resolved.
export const SET_ASIDE = [['**/pubspec.lock', 'pub get']];

// Generated-file patterns of the adapters on for a repository's files, the files set aside, and
// .review.yaml's, each with where it comes from.
export function generatedGlobs(paths, review) {
  const on = (k) => (review && review.adapters && k in review.adapters ? !!review.adapters[k] : paths.some((p) => ADAPTERS[k].detect.test(p)));
  return Object.keys(ADAPTERS).filter(on).flatMap((k) => ADAPTERS[k].generated.map((g) => [g, k + ' adapter']))
    .concat(SET_ASIDE, ((review && review.generated) || []).map((g) => [g, '.review.yaml']));
}
